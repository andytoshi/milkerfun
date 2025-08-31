# MilkerFun by andytoshi - Solana Cow Farming Game

A Solana-based idle farming game where users can buy cows, earn MILK tokens, and compound their earnings.

## Features

- **Buy Cows**: Purchase cows with MILK tokens (price doubles every hour, capped at 16x)
- **Earn Rewards**: Cows produce MILK tokens automatically (rate halves every 10 days)
- **Withdraw MILK**: Claim accumulated rewards
- **Compound**: Use rewards to buy more cows without withdrawing

## Program Architecture

### Accounts
- **Config**: Global configuration (admin, mint, rates, start time)
- **FarmAccount**: User-specific data (cows, rewards, last update)

### Instructions
- `initialize_config`: Set up the program (admin only)
- `buy_cows`: Purchase cows with MILK tokens
- `withdraw_milk`: Claim accumulated rewards
- `compound_cows`: Use rewards to buy more cows

### Economic Model
- **Initial Cow Price**: 6,000 MILK
- **Price Escalation**: Doubles every hour (max 16x after 4 hours)
- **Base Reward Rate**: 100 MILK per cow per minute
- **Halving Schedule**: Rate halves every 10 days
- **Minimum Rate**: 10 MILK per cow per minute

## Setup Instructions

### Prerequisites
1. Install Rust: https://rustup.rs/
2. Install Solana CLI: https://docs.solana.com/cli/install-solana-cli-tools
3. Install Anchor: https://www.anchor-lang.com/docs/installation
4. Install Node.js and Yarn

### Development Setup

1. **Clone and Install Dependencies**
   ```bash
   git clone <your-repo>
   cd milkerfun
   yarn install
   ```

2. **Generate a New Keypair**
   ```bash
   solana-keygen new --outfile ~/.config/solana/id.json
   ```

3. **Build the Program**
   ```bash
   anchor build
   ```

4. **Run Tests**
   ```bash
   anchor test
   ```

### Devnet Deployment

**Important**: This program uses the existing MILK token.

1. **Switch to Devnet**
   ```bash
   solana config set --url devnet
   ```

2. **Update MILK Token Address**
   ```bash
   # Edit scripts/deploy-setup.ts and paste the MILK mint addresses
   ```

3. **Airdrop SOL for Deployment**
   ```bash
   solana airdrop 2
   ```

4. **Deploy Program**
   ```bash
   anchor deploy --provider.cluster devnet
   ```

5. **Initialize Program**
   ```bash
   yarn deploy-setup
   ```

6. **Fund Pool with MILK Tokens**
   ```bash
   yarn fund-pool 1000000  # 1M MILK tokens
   ```

7. **Setup User Account**
   ```bash
   yarn user-setup
   ```

### Mainnet Deployment

**Important**: You need MILK tokens for funding the reward pool.

1. **Switch to Mainnet**
   ```bash
   solana config set --url mainnet-beta
   ```

2. **Update MILK Token Address**
   ```bash
   # Edit scripts/deploy-setup.ts and paste the mainnet MILK mint address
   ```

3. **Ensure Sufficient SOL Balance**
   ```bash
   solana balance
   # You need ~5-10 SOL for deployment and setup
   ```

4. **Deploy Program**
   ```bash
   anchor deploy --provider.cluster mainnet
   ```

5. **Initialize Program**
   ```bash
   yarn deploy-setup
   ```

6. **Fund the Reward Pool**
   ```bash
   yarn fund-pool 5000000  # 5M MILK tokens for mainnet
   ```

## Usage Scripts

### Check Program Status
```bash
yarn check-status
```

### Get Pool Address for Frontend
```bash
yarn get-pool-address
```

### Setup New User
```bash
yarn user-setup
```

### Deploy and Initialize
```bash
yarn deploy-setup
```

## MILK Token Integration

This program integrates with the existing MILK token:
- **Decimals**: 6 (matches existing MILK token)
- **Devnet Address**: [Update with actual devnet MILK address]
- **Mainnet Address**: [Update with actual mainnet MILK address]

### Important Notes:
1. **Pool Funding**: After deployment, you must manually fund the pool token account with MILK tokens
2. **User Tokens**: Users need existing MILK tokens to participate
3. **No Minting**: The program doesn't mint new MILK tokens, only redistributes existing ones

## Testing

The test suite includes:
- Configuration initialization
- Cow purchasing
- Reward accumulation
- Milk withdrawal
- Cow compounding
- Error handling

Run tests with:
```bash
anchor test
```

## Program Addresses

After deployment, save these addresses:
- **Program ID**: 11111111111111111111111111111111 (update after deployment)
- **MILK Mint**: (created during setup)
- **Config PDA**: (derived from program)
- **Pool Authority PDA**: (derived from config)

## Security Features

- **PDA-based accounts**: All program accounts use Program Derived Addresses
- **Owner validation**: Users can only access their own farms
- **Overflow protection**: All math operations check for overflow
- **Token validation**: Ensures correct mint and ownership

## Frontend Integration

Key functions for frontend:
1. `buy_cows(num_cows)` - Purchase cows
2. `withdraw_milk()` - Claim rewards
3. `compound_cows(num_cows)` - Reinvest rewards

Key PDAs to derive:
- Config: `["config"]`
- Farm: `["farm", user_pubkey]`
- Pool Authority: `["pool_authority", config_pubkey]`

## Monitoring

Use the status script to monitor:
- Current cow prices
- Reward rates
- User farm status
- Token balances

```bash
anchor run check-status
```

## Troubleshooting

### Common Issues

1. **"Program not deployed"**
   - Run `anchor deploy` first

2. **"Insufficient funds"**
   - Airdrop more SOL: `solana airdrop 2`

3. **"Account not found"**
   - Initialize config: `anchor run deploy-setup`

4. **"Invalid mint"**
   - Ensure using correct MILK token mint address

### Logs
Check program logs with:
```bash
solana logs <program-id>
```

## License

MIT License