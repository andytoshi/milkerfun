use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

const SECONDS_PER_DAY: i64 = 86400; // 24 * 60 * 60
const HALVING_INTERVAL_DAYS: i64 = 10;
const MIN_REWARD_RATE: u64 = 10_000_000; // Minimum 10 MILK per cow per minute
const MAX_HALVING_PERIODS: u32 = 10; // Cap at 2^10 to prevent overflow
const REWARDS_PER_MINUTE_TO_SECOND: u64 = 60;
const MAX_PRICE_MULTIPLIER_HOURS: u64 = 4; // Cap price escalation at 4 hours (16x)

declare_id!("11111111111111111111111111111111");

#[program]
pub mod milkerfun {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let current_time = Clock::get()?.unix_timestamp;
        
        config.admin = ctx.accounts.admin.key();
        config.milk_mint = ctx.accounts.milk_mint.key();
        config.base_milk_per_cow_per_min = 100_000_000; // 100 MILK tokens (6 decimals)
        config.cow_initial_cost = 6_000_000_000; // 6000 MILK tokens (6 decimals)
        config.start_time = current_time;
        
        msg!("Config initialized - Start time: {}, Base rate: {} MILK/cow/min", 
             current_time, config.base_milk_per_cow_per_min);
        Ok(())
    }

    pub fn buy_cows(ctx: Context<BuyCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &ctx.accounts.config;
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
            // Update accumulated rewards before buying
            update_farm_rewards(farm, config, current_time)?;
        }

        // Calculate current cow price
        let cost_per_cow = get_current_cow_price(config, current_time)?;
        let total_cost = cost_per_cow
            .checked_mul(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Buying {} cows at {} each, total cost: {}", num_cows, cost_per_cow, total_cost);

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

        // Update farm state
        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Successfully bought {} cows. Total cows: {}", num_cows, farm.cows);
        Ok(())
    }

    pub fn withdraw_milk(ctx: Context<WithdrawMilk>) -> Result<()> {
        let config = &ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Update rewards first
        update_farm_rewards(farm, config, current_time)?;

        require!(farm.accumulated_rewards > 0, ErrorCode::NoRewardsAvailable);

        let total_rewards = farm.accumulated_rewards;
        msg!("Withdrawing {} MILK tokens", total_rewards);

        // Create signer seeds for pool authority
        let config_key = config.key();
        let seeds = &[
            b"pool_authority",
            config_key.as_ref(),
            &[ctx.bumps.pool_authority],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer rewards from pool to user
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
            total_rewards,
        )?;

        // Reset accumulated rewards
        farm.accumulated_rewards = 0;

        msg!("Successfully withdrew {} MILK tokens", total_rewards);
        Ok(())
    }

    pub fn compound_cows(ctx: Context<CompoundCows>, num_cows: u64) -> Result<()> {
        require!(num_cows > 0, ErrorCode::InvalidAmount);
        
        let config = &ctx.accounts.config;
        let farm = &mut ctx.accounts.farm;
        let current_time = Clock::get()?.unix_timestamp;

        // Update rewards first
        update_farm_rewards(farm, config, current_time)?;

        // Calculate current cow price
        let cow_price = get_current_cow_price(config, current_time)?;
        let total_cost = cow_price
            .checked_mul(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            farm.accumulated_rewards >= total_cost,
            ErrorCode::InsufficientRewards
        );

        msg!("Compounding {} cows using {} rewards", num_cows, total_cost);

        // Deduct cost from available rewards
        farm.accumulated_rewards = farm.accumulated_rewards
            .checked_sub(total_cost)
            .ok_or(ErrorCode::MathOverflow)?;

        // Add new cows
        farm.cows = farm.cows
            .checked_add(num_cows)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!("Successfully compounded {} cows. Total cows: {}", num_cows, farm.cows);
        Ok(())
    }
}

/// Calculate current reward rate based on halving schedule
fn get_current_reward_rate(config: &Config, current_time: i64) -> u64 {
    let days_elapsed = (current_time - config.start_time) / SECONDS_PER_DAY;
    let halving_periods = (days_elapsed / HALVING_INTERVAL_DAYS).min(MAX_HALVING_PERIODS as i64) as u32;
    
    // Calculate halved rate: base_rate / (2^halving_periods)
    let divisor = 1u64 << halving_periods; // More efficient than pow()
    let current_rate = config.base_milk_per_cow_per_min / divisor;
    
    // Ensure minimum rate
    current_rate.max(MIN_REWARD_RATE)
}

/// Calculate rewards for a time period with potential rate changes
fn calculate_rewards_with_halving(
    config: &Config,
    cows: u64,
    start_time: i64,
    end_time: i64,
) -> Result<u64> {
    if start_time >= end_time || cows == 0 {
        return Ok(0);
    }

    let mut total_rewards = 0u64;
    let mut current_period_start = start_time;

    // Calculate rewards for each potential halving period
    while current_period_start < end_time {
        // Find the end of current halving period
        let days_since_start = (current_period_start - config.start_time) / SECONDS_PER_DAY;
        let current_halving_period = days_since_start / HALVING_INTERVAL_DAYS;
        let next_halving_time = config.start_time + 
            ((current_halving_period + 1) * HALVING_INTERVAL_DAYS * SECONDS_PER_DAY);
        
        let current_period_end = end_time.min(next_halving_time);
        let period_duration = (current_period_end - current_period_start) as u64;
        
        if period_duration > 0 {
            let rate_for_period = get_current_reward_rate(config, current_period_start);
            let rewards_per_cow_per_second = rate_for_period / REWARDS_PER_MINUTE_TO_SECOND;
            
            let period_rewards = cows
                .checked_mul(rewards_per_cow_per_second)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_mul(period_duration)
                .ok_or(ErrorCode::MathOverflow)?;
            
            total_rewards = total_rewards
                .checked_add(period_rewards)
                .ok_or(ErrorCode::MathOverflow)?;
            
            msg!("Period: {} to {}, Rate: {}, Duration: {}s, Rewards: {}", 
                 current_period_start, current_period_end, rate_for_period, period_duration, period_rewards);
        }
        
        current_period_start = current_period_end;
    }

    Ok(total_rewards)
}

/// Calculate current cow price based on elapsed time
fn get_current_cow_price(config: &Config, current_time: i64) -> Result<u64> {
    let elapsed_hours = ((current_time - config.start_time) / 3600).max(0) as u64;
    let capped_hours = elapsed_hours.min(MAX_PRICE_MULTIPLIER_HOURS);
    
    // Use bit shifting instead of pow for efficiency: 2^n = 1 << n
    let multiplier = 1u64 << capped_hours;
    
    config.cow_initial_cost
        .checked_mul(multiplier)
        .ok_or(ErrorCode::MathOverflow.into())
}

/// Update farm rewards before any operation
fn update_farm_rewards(farm: &mut FarmAccount, config: &Config, current_time: i64) -> Result<()> {
    if farm.cows > 0 && current_time > farm.last_update_time {
        let new_rewards = calculate_rewards_with_halving(
            config,
            farm.cows,
            farm.last_update_time,
            current_time,
        )?;

        if new_rewards > 0 {
            farm.accumulated_rewards = farm.accumulated_rewards
                .checked_add(new_rewards)
                .ok_or(ErrorCode::MathOverflow)?;
            
            msg!("Updated rewards: +{}, Total: {}", new_rewards, farm.accumulated_rewards);
        }
    }
    
    farm.last_update_time = current_time;
    Ok(())
}

#[account]
pub struct Config {
    pub admin: Pubkey,                    // 32 bytes
    pub milk_mint: Pubkey,               // 32 bytes  
    pub base_milk_per_cow_per_min: u64,  // 8 bytes
    pub cow_initial_cost: u64,           // 8 bytes
    pub start_time: i64,                 // 8 bytes
}

#[account]
pub struct FarmAccount {
    pub owner: Pubkey,               // 32 bytes
    pub cows: u64,                   // 8 bytes
    pub last_update_time: i64,       // 8 bytes
    pub accumulated_rewards: u64,    // 8 bytes
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 8 + 8 + 8, // discriminator + Config struct
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = milk_mint.decimals <= 9)]
    pub milk_mint: Account<'info, Mint>,

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
        space = 8 + 32 + 8 + 8 + 8, // discriminator + FarmAccount struct
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
}