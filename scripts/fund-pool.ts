import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { transfer, getAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Script to fund the reward pool with MILK tokens
 * Run this after deploy-setup to add MILK tokens to the pool
 */
async function main() {
  // Set up provider manually to avoid env variable issues
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  
  // Load wallet from default Solana CLI location
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );
  
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.milkerfun as Program<Milkerfun>;

  // Get amount from command line argument
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: yarn fund-pool <amount_in_milk>");
    console.error("Example: yarn fund-pool 1000000");
    process.exit(1);
  }

  const amountInMilk = parseFloat(args[0]);
  const amountInTokens = Math.floor(amountInMilk * 1_000_000); // Convert to 6 decimal places

  console.log(`Funding pool with ${amountInMilk} MILK tokens (${amountInTokens} raw tokens)`);

  // Get config to find addresses
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const config = await program.account.config.fetch(configPda);
  const milkMint = config.milkMint;

  const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), configPda.toBuffer()],
    program.programId
  );

  // Find pool token account
  const poolTokenAccounts = await provider.connection.getTokenAccountsByOwner(
    poolAuthorityPda,
    { mint: milkMint }
  );

  if (poolTokenAccounts.value.length === 0) {
    console.error("Pool token account not found. Run deploy-setup first.");
    process.exit(1);
  }

  const poolTokenAccount = poolTokenAccounts.value[0].pubkey;

  // Find user's token account
  const userTokenAccounts = await provider.connection.getTokenAccountsByOwner(
    wallet.publicKey,
    { mint: milkMint }
  );

  if (userTokenAccounts.value.length === 0) {
    console.error("You don't have a MILK token account. Run user-setup first or acquire MILK tokens.");
    process.exit(1);
  }

  const userTokenAccount = userTokenAccounts.value[0].pubkey;

  // Check user balance
  const userBalance = await getAccount(provider.connection, userTokenAccount);
  const userBalanceInMilk = Number(userBalance.amount) / 1_000_000;

  console.log(`Your current balance: ${userBalanceInMilk} MILK`);

  if (Number(userBalance.amount) < amountInTokens) {
    console.error(`Insufficient balance. You have ${userBalanceInMilk} MILK but need ${amountInMilk} MILK`);
    process.exit(1);
  }

  // Transfer tokens to pool
  console.log("Transferring tokens to pool...");
  
  const signature = await transfer(
    provider.connection,
    wallet.payer,
    userTokenAccount,
    poolTokenAccount,
    wallet.publicKey,
    amountInTokens
  );

  console.log("Transfer signature:", signature);

  // Verify transfer
  const poolBalance = await getAccount(provider.connection, poolTokenAccount);
  const poolBalanceInMilk = Number(poolBalance.amount) / 1_000_000;

  console.log("\n=== Pool Funding Complete ===");
  console.log(`Pool balance: ${poolBalanceInMilk} MILK`);
  console.log(`Pool token account: ${poolTokenAccount.toString()}`);
  console.log("\nThe game is now ready for users!");
}

main().catch((error) => {
  console.error("Pool funding failed:", error);
  process.exit(1);
});