use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn},
    metadata::{
        create_metadata_accounts_v3,
        mpl_token_metadata::types::{DataV2, Creator},
        CreateMetadataAccountsV3, Metadata,
    },
};

const SECONDS_PER_DAY: i64 = 86400; // 24 * 60 * 60
const COW_BASE_PRICE: u64 = 6_000_000_000; // 6,000 MILK (6 decimals)
const PRICE_PIVOT: f64 = 3_000.0; // C_pivot
const PRICE_STEEPNESS: f64 = 2.0; // α
const REWARD_BASE: u64 = 25_000_000_000; // 25,000 MILK (6 decimals) - B
const REWARD_SENSITIVITY: f64 = 0.5; // α_reward
const TVL_NORMALIZATION: f64 = 100_000_000_000.0; // 100,000 MILK (6 decimals) - S
const MIN_REWARD_PER_DAY: u64 = 1_000_000_000; // 1,000 MILK per day (6 decimals) - R_min
const GREED_MULTIPLIER: f64 = 8.0; // β
const GREED_DECAY_PIVOT: f64 = 1_500.0; // C₀
const INITIAL_TVL: u64 = 100_000_000_000_000; // 100M MILK (6 decimals)
const MAX_COWS_PER_TRANSACTION: u64 = 50; // Maximum cows per buy transaction

declare_id!("11111111111111111111111111111111");

#[program]
pub mod milkerfun {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let current_time = Clock::get()?.unix_timestamp;
        
        config.admin = ctx.accounts.admin.key();
        config.milk_mint = ctx.accounts.milk_mint.key();
        config.pool_token_account = ctx.accounts.pool_token_account.key();
        config.cow_mint = ctx.accounts.cow_mint.key();
        config.start_time = current_time;
        config.global_cows_count = 0;
        config.initial_tvl = INITIAL_TVL;
        
        // Create metadata for COW token (SPL token style - no collection)
        let config_key = config.key();
        let seeds = &[
            b"cow_mint_authority",
            config_key.as_ref(),
            &[ctx.bumps.cow_mint_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.cow_metadata.to_account_info(),
                    mint: ctx.accounts.cow_mint.to_account_info(),
                    mint_authority: ctx.accounts.cow_mint_authority.to_account_info(),
                    update_authority: ctx.accounts.cow_mint_authority.to_account_info(),
                    payer: ctx.accounts.admin.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            DataV2 {
                name: "MilkerFuns".to_string(),
                symbol: "COW".to_string(),
                uri: "https://raw.githubusercontent.com/andytoshi/milkerfun/refs/heads/v3/cowmeta.json".to_string(),
                seller_fee_basis_points: 0,
                creators: Some(vec![Creator {
                    address: ctx.accounts.cow_mint_authority.key(),
                    verified: true,
                    share: 100,
                }]),
                collection: None, // CRITICAL: No collection = SPL token behavior
                uses: None,
            },
            true,  // is_mutable
            true,  // update_authority_is_signer
            None,  // collection_details = None for SPL tokens
        )?;

        msg!("Config initialized - Start time: {}, Initial TVL: {} MILK, Pool: {}, COW Mint: {}", 
             current_time, INITIAL_TVL / 1_000_000, config.pool_token_account, config.cow_mint);
        Ok(())
    }


    pub fn buy_cows(ctx: Context<BuyCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        require!(num_cows <= MAX_COWS_PER_TRANSACTION, ErrorCode::ExceedsMaxCowsPerTransaction);
        
        let config = &mut ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        if farm.owner == Pubkey::default() {
            farm.owner = ctx.accounts.user.key();
            farm.cows = 0;
            farm.last_update_time = current_time;
            farm.accumulated_rewards = 0;
            msg!("Initialized new farm for user: {}", ctx.accounts.user.key());
        } else {
            update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;
        }

        let cost_per_cow = calculate_cow_price(config.global_cows_count)?;
        let total_cost = cost_per_cow
            .checked_mul(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Buying {} cows at {} each (global count: {}), total cost: {}", 
             num_cows, cost_per_cow, config.global_cows_count, total_cost);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            total_cost,
        )?;

        config.global_cows_count = config.global_cows_count
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        let new_tvl = ctx.accounts.pool_token_account.amount
            .checked_add(total_cost)
            .ok_or(ErrorCode::MathOverflow)?;
        
        let new_reward_rate = calculate_reward_rate(config.global_cows_count, new_tvl)?;
        farm.last_reward_rate = new_reward_rate;

        msg!("Successfully bought {} cows. User total: {}, Global total: {}, New rate: {} MILK/cow/day", 
             num_cows, farm.cows, config.global_cows_count, new_reward_rate / 1_000_000);
        Ok(())
    }

    pub fn withdraw_milk(ctx: Context<WithdrawMilk>) -> Result<()> {
        let config = &ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;

        require!(farm.accumulated_rewards > 0, ErrorCode::NoRewardsAvailable);

        let total_rewards = farm.accumulated_rewards;
        
        let hours_since_last_withdraw = if farm.last_withdraw_time == 0 {
            25 // First withdrawal - no penalty
        } else {
            (current_time - farm.last_withdraw_time) / 3600 // Convert to hours
        };
        
        let (withdrawal_amount, penalty_amount) = if hours_since_last_withdraw >= 24 {
            msg!("Penalty-free withdrawal: {} MILK tokens", total_rewards / 1_000_000);
            (total_rewards, 0)
        } else {
            let withdrawal = total_rewards / 2;
            let penalty = total_rewards - withdrawal;
            msg!("Withdrawal with 50% penalty: withdrawing {} MILK, {} MILK penalty stays in pool (last withdraw: {} hours ago)", 
                 withdrawal / 1_000_000, penalty / 1_000_000, hours_since_last_withdraw);
            (withdrawal, penalty)
        };

        let pool_balance = ctx.accounts.pool_token_account.amount;
        let withdrawal_amount = withdrawal_amount.min(pool_balance);

        let config_key = config.key();
        let seeds = &[
            b"pool_authority",
            config_key.as_ref(),
            &[ctx.bumps.pool_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            withdrawal_amount,
        )?;

        let new_tvl = ctx.accounts.pool_token_account.amount
            .checked_sub(withdrawal_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        
        let new_reward_rate = calculate_reward_rate(config.global_cows_count, new_tvl)?;
        farm.last_reward_rate = new_reward_rate;

        farm.accumulated_rewards = 0;
        farm.last_withdraw_time = current_time;

        if penalty_amount > 0 {
            msg!("Successfully withdrew {} MILK tokens with {} MILK penalty remaining in pool. New rate: {} MILK/cow/day", 
                 withdrawal_amount / 1_000_000, penalty_amount / 1_000_000, new_reward_rate / 1_000_000);
        } else {
            msg!("Successfully withdrew {} MILK tokens (penalty-free). New rate: {} MILK/cow/day", 
                 withdrawal_amount / 1_000_000, new_reward_rate / 1_000_000);
        }
        
        Ok(())
    }

    pub fn compound_cows(ctx: Context<CompoundCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &mut ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;

        let cow_price = calculate_cow_price(config.global_cows_count)?;
        let total_cost = cow_price
            .checked_mul(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            farm.accumulated_rewards >= total_cost,
            ErrorCode::InsufficientRewards
        );

        msg!("Compounding {} cows using {} rewards (global count: {})", 
             num_cows, total_cost, config.global_cows_count);

        farm.accumulated_rewards = farm.accumulated_rewards
            .checked_sub(total_cost)
            .ok_or(ErrorCode::MathOverflow)?;

        config.global_cows_count = config.global_cows_count
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        let new_reward_rate = calculate_reward_rate(config.global_cows_count, ctx.accounts.pool_token_account.amount)?;
        farm.last_reward_rate = new_reward_rate;

        msg!("Successfully compounded {} cows. User total: {}. Global total: {}. New rate: {} MILK/cow/day", 
             num_cows, farm.cows, config.global_cows_count, new_reward_rate / 1_000_000);
        Ok(())
    }

    pub fn get_global_stats(ctx: Context<GetGlobalStats>) -> Result<GlobalStats> {
        let config = &ctx.accounts.config;
        let pool_balance = ctx.accounts.pool_token_account.amount;
        
        Ok(GlobalStats {
            global_cows_count: config.global_cows_count,
            pool_balance_milk: pool_balance,
        })
    }

    pub fn v3_migrating(ctx: Context<V3Migrating>) -> Result<()> {
        let config = &ctx.accounts.config;
        let pool_balance = ctx.accounts.pool_token_account.amount;
        
        require!(pool_balance > 0, ErrorCode::NoFundsToMigrate);
        
        msg!("V3 Migration");

        let config_key = config.key();
        let seeds = &[
            b"pool_authority",
            config_key.as_ref(),
            &[ctx.bumps.pool_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_account.to_account_info(),
                    to: ctx.accounts.admin_token_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer_seeds,
            ),
            pool_balance,
        )?;

        msg!("V3 Migration completed");
        Ok(())
    }

    pub fn export_cows(ctx: Context<ExportCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Update rewards before export (user keeps accumulated rewards)
        update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;

        require!(farm.cows >= num_cows, ErrorCode::InsufficientCows);

        msg!("Exporting {} cows to COW tokens for user: {}", num_cows, ctx.accounts.user.key());

        // Reduce cow count in farm
        farm.cows = farm.cows
            .checked_sub(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Mint COW tokens to user (1 cow = 1 COW token with 0 decimals)
        let config_key = config.key();
        let seeds = &[
            b"cow_mint_authority",
            config_key.as_ref(),
            &[ctx.bumps.cow_mint_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.cow_mint.to_account_info(),
                    to: ctx.accounts.user_cow_token_account.to_account_info(),
                    authority: ctx.accounts.cow_mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            num_cows, // COW tokens have 0 decimals, so 1 cow = 1 token
        )?;

        msg!("Successfully exported {} cows to COW tokens. User cows remaining: {}", 
             num_cows, farm.cows);
        Ok(())
    }

    pub fn import_cows(ctx: Context<ImportCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &mut ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Initialize farm if needed
        if farm.owner == Pubkey::default() {
            farm.owner = ctx.accounts.user.key();
            farm.cows = 0;
            farm.last_update_time = current_time;
            farm.accumulated_rewards = 0;
            msg!("Initialized new farm for user: {}", ctx.accounts.user.key());
        } else {
            // Update rewards before import
            update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;
        }

        msg!("Importing {} COW tokens to cows for user: {}", num_cows, ctx.accounts.user.key());

        // Burn COW tokens from user
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.cow_mint.to_account_info(),
                    from: ctx.accounts.user_cow_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            num_cows, // COW tokens have 0 decimals
        )?;

        // Add cows to farm
        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Update global cow count
        config.global_cows_count = config.global_cows_count
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Calculate new reward rate
        let new_reward_rate = calculate_reward_rate(config.global_cows_count, ctx.accounts.pool_token_account.amount)?;
        farm.last_reward_rate = new_reward_rate;

        msg!("Successfully imported {} COW tokens to cows. User total cows: {}, Global total: {}", 
             num_cows, farm.cows, config.global_cows_count);
        Ok(())
    }
}

/// Calculate dynamic cow price based on global cow count
/// P(c) = 6,000 * (1 + (c / 1,500)^1.2)
fn calculate_cow_price(global_cows: u64) -> Result<u64> {
    if global_cows == 0 {
        return Ok(COW_BASE_PRICE);
    }

    let c = global_cows as f64;
    let ratio = c / PRICE_PIVOT;
    let power_term = if ratio == 0.0 { 0.0 } else { ratio.powf(PRICE_STEEPNESS) };
    let multiplier = 1.0 + power_term;
    
    let price_f64 = (COW_BASE_PRICE as f64) * multiplier;
    
    if price_f64 > (u64::MAX as f64) {
        return Err(ErrorCode::MathOverflow.into());
    }
    
    let price = price_f64 as u64;
    
    msg!("Cow price calculation: global_cows={}, ratio={:.4}, power_term={:.4}, multiplier={:.4}, price={}", 
         global_cows, ratio, power_term, multiplier, price);
    
    Ok(price)
}

/// Calculate dynamic reward rate per cow per day
/// R_cow = max(B / (1 + α_reward * (TVL/C) / S), R_min) * G(C)
fn calculate_reward_rate(global_cows: u64, tvl: u64) -> Result<u64> {
    if global_cows == 0 {
        return Ok(MIN_REWARD_PER_DAY);
    }

    let tvl_f64 = tvl as f64;
    let cows_f64 = global_cows as f64;
    let tvl_per_cow = tvl_f64 / cows_f64;
    let normalized_ratio = tvl_per_cow / TVL_NORMALIZATION;
    
    let denominator = 1.0 + (REWARD_SENSITIVITY * normalized_ratio);
    let base_reward = (REWARD_BASE as f64) / denominator;
    
    let greed_decay = if cows_f64 == 0.0 { 1.0 } else { (-cows_f64 / GREED_DECAY_PIVOT).exp() };
    let greed_multiplier = 1.0 + (GREED_MULTIPLIER * greed_decay);
    
    let reward_with_greed = base_reward * greed_multiplier;
    let final_reward = reward_with_greed.max(MIN_REWARD_PER_DAY as f64);
    
    if final_reward > (u64::MAX as f64) {
        return Err(ErrorCode::MathOverflow.into());
    }
    
    let reward_rate = final_reward as u64;
    
    msg!("Reward calculation: cows={}, tvl={}, tvl_per_cow={:.2}, ratio={:.6}, base={:.2}, greed={:.4}, final={}", 
         global_cows, tvl, tvl_per_cow / 1_000_000.0, normalized_ratio, 
         base_reward / 1_000_000.0, greed_multiplier, reward_rate / 1_000_000);
    
    Ok(reward_rate)
}

/// Update farm rewards using the stored reward rate
/// Only recalculates rate when triggered by buy/compound operations
fn update_farm_rewards(
    farm: &mut FarmAccount, 
    config: &Config, 
    current_time: i64,
    current_tvl: u64
) -> Result<()> {
    if farm.cows > 0 && current_time > farm.last_update_time {
        let time_elapsed = (current_time - farm.last_update_time) as u64;
        
        let reward_rate = if farm.last_reward_rate == 0 {
            calculate_reward_rate(config.global_cows_count, current_tvl)?
        } else {
            farm.last_reward_rate
        };
        
        let reward_per_cow_per_second = reward_rate / (SECONDS_PER_DAY as u64);
        
        let new_rewards = farm.cows
            .checked_mul(reward_per_cow_per_second)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_mul(time_elapsed)
            .ok_or(ErrorCode::MathOverflow)?;

        if new_rewards > 0 {
            farm.accumulated_rewards = farm.accumulated_rewards
                .checked_add(new_rewards)
                .ok_or(ErrorCode::MathOverflow)?;
            
            msg!("Updated rewards: +{} (rate: {} MILK/cow/day, time: {}s), Total: {}", 
                 new_rewards, reward_rate / 1_000_000, time_elapsed, farm.accumulated_rewards);
        }
    }
    
    farm.last_update_time = current_time;
    Ok(())
}

#[account]
pub struct Config {
    pub admin: Pubkey,                    // 32 bytes
    pub milk_mint: Pubkey,               // 32 bytes  
    pub cow_mint: Pubkey,                // 32 bytes
    pub pool_token_account: Pubkey,      // 32 bytes
    pub start_time: i64,                 // 8 bytes
    pub global_cows_count: u64,          // 8 bytes
    pub initial_tvl: u64,                // 8 bytes - for reference
}

#[account]
pub struct FarmAccount {
    pub owner: Pubkey,               // 32 bytes
    pub cows: u64,                   // 8 bytes
    pub last_update_time: i64,       // 8 bytes
    pub accumulated_rewards: u64,    // 8 bytes
    pub last_reward_rate: u64,       // 8 bytes - MILK per cow per day
    pub last_withdraw_time: i64,     // 8 bytes - timestamp of last withdrawal
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8, // discriminator + Config struct
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = milk_mint.decimals <= 9)]
    pub milk_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 0,
        mint::authority = cow_mint_authority,
        mint::freeze_authority = cow_mint_authority,
        seeds = [b"cow_mint", config.key().as_ref()],
        bump
    )]
    pub cow_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"cow_mint_authority", config.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used as mint authority for COW tokens
    pub cow_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Metadata account for COW token
    #[account(mut)]
    pub cow_metadata: UncheckedAccount<'info>,
    /// CHECK: Pool token account will be validated during runtime
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Metaplex Token Metadata Program
    pub token_metadata_program: UncheckedAccount<'info>,
}


#[derive(Accounts)]
pub struct BuyCows<'info> {
    #[account(
        mut,
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 32 + 8 + 8 + 8 + 8 + 8, // discriminator + FarmAccount struct
        seeds = [b"farm", user.key().as_ref()],
        bump
    )]
    pub farm: Account<'info, FarmAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.mint == config.milk_mint @ ErrorCode::InvalidMint,
        constraint = user_token_account.owner == user.key() @ ErrorCode::InvalidOwner
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_account.mint == config.milk_mint @ ErrorCode::InvalidMint,
        constraint = pool_token_account.owner == pool_authority.key() @ ErrorCode::InvalidOwner
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"pool_authority", config.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used as authority for token transfers
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompoundCows<'info> {
    #[account(
        mut,
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"farm", user.key().as_ref()],
        bump,
        constraint = farm.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub farm: Account<'info, FarmAccount>,

    #[account(
        constraint = pool_token_account.key() == config.pool_token_account @ ErrorCode::InvalidPoolAccount
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawMilk<'info> {
    #[account(
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"farm", user.key().as_ref()],
        bump,
        constraint = farm.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub farm: Account<'info, FarmAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.mint == config.milk_mint @ ErrorCode::InvalidMint,
        constraint = user_token_account.owner == user.key() @ ErrorCode::InvalidOwner
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_account.mint == config.milk_mint @ ErrorCode::InvalidMint
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"pool_authority", config.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used as authority for token transfers
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GetGlobalStats<'info> {
    #[account(
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        constraint = pool_token_account.key() == config.pool_token_account @ ErrorCode::InvalidPoolAccount
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ExportCows<'info> {
    #[account(
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"farm", user.key().as_ref()],
        bump,
        constraint = farm.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub farm: Account<'info, FarmAccount>,

    #[account(
        mut,
        constraint = cow_mint.key() == config.cow_mint @ ErrorCode::InvalidCowMint
    )]
    pub cow_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"cow_mint_authority", config.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used as mint authority for COW tokens
    pub cow_mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = user_cow_token_account.mint == config.cow_mint @ ErrorCode::InvalidMint,
        constraint = user_cow_token_account.owner == user.key() @ ErrorCode::InvalidOwner
    )]
    pub user_cow_token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = pool_token_account.key() == config.pool_token_account @ ErrorCode::InvalidPoolAccount
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ImportCows<'info> {
    #[account(
        mut,
        seeds = [b"config"], 
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 32 + 8 + 8 + 8 + 8 + 8, // discriminator + FarmAccount struct
        seeds = [b"farm", user.key().as_ref()],
        bump
    )]
    pub farm: Account<'info, FarmAccount>,

    #[account(
        mut,
        constraint = cow_mint.key() == config.cow_mint @ ErrorCode::InvalidCowMint
    )]
    pub cow_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_cow_token_account.mint == config.cow_mint @ ErrorCode::InvalidMint,
        constraint = user_cow_token_account.owner == user.key() @ ErrorCode::InvalidOwner
    )]
    pub user_cow_token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = pool_token_account.key() == config.pool_token_account @ ErrorCode::InvalidPoolAccount
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct V3Migrating<'info> {
    #[account(
        seeds = [b"config"], 
        bump,
        constraint = config.admin == admin.key() @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = admin_token_account.mint == config.milk_mint @ ErrorCode::InvalidMint,
        constraint = admin_token_account.owner == admin.key() @ ErrorCode::InvalidOwner
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_account.key() == config.pool_token_account @ ErrorCode::InvalidPoolAccount
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"pool_authority", config.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used as authority for token transfers
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct GlobalStats {
    pub global_cows_count: u64,
    pub pool_balance_milk: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Insufficient rewards to buy cows")]
    InsufficientRewards,
    #[msg("No rewards available for withdrawal")]
    NoRewardsAvailable,
    #[msg("Invalid amount - must be greater than 0")]
    InvalidAmount,
    #[msg("Invalid mint address")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Invalid pool token account")]
    InvalidPoolAccount,
    #[msg("No funds available for migration")]
    NoFundsToMigrate,
    #[msg("Cannot buy more than 50 cows per transaction")]
    ExceedsMaxCowsPerTransaction,
    #[msg("Insufficient cows to export")]
    InsufficientCows,
    #[msg("Invalid COW mint address")]
    InvalidCowMint,
}