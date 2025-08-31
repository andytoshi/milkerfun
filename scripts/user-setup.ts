import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import {
  createInitializeAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * User setup script - creates token account for MILK token
 * Run this for each user who wants to interact with the program
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

  // Get config to find MILK mint
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const config = await program.account.config.fetch(configPda);
  const milkMint = config.milkMint;

  console.log("Setting up user:", wallet.publicKey.toString());
  console.log("MILK Mint:", milkMint.toString());

  // Check if user already has a MILK token account
  const existingAccounts = await provider.connection.getTokenAccountsByOwner(
    wallet.publicKey,
    { mint: milkMint }
  );

  let userTokenAccount: PublicKey;

  if (existingAccounts.value.length > 0) {
    userTokenAccount = existingAccounts.value[0].pubkey;
    console.log("Found existing MILK token account:", userTokenAccount.toString());
    
    const balance = await getAccount(provider.connection, userTokenAccount);
    console.log("Current balance:", Number(balance.amount) / 1_000_000, "MILK");
  } else {
    // Create user token account
    console.log("Creating new MILK token account...");
    
    // Create token account manually
    const tokenAccountKeypair = anchor.web3.Keypair.generate();
    userTokenAccount = tokenAccountKeypair.publicKey;
    
    // Calculate rent for token account
    const tokenAccountSpace = 165; // Standard token account size
    const rent = await provider.connection.getMinimumBalanceForRentExemption(tokenAccountSpace);
    
    // Create the token account transaction
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: userTokenAccount,
      lamports: rent,
      space: tokenAccountSpace,
      programId: TOKEN_PROGRAM_ID,
    });
    
    const initializeAccountIx = createInitializeAccountInstruction(
      userTokenAccount,
      milkMint,
      wallet.publicKey,
      TOKEN_PROGRAM_ID
    );
    
    const transaction = new Transaction()
      .add(createAccountIx)
      .add(initializeAccountIx);
    
    await provider.sendAndConfirm(transaction, [wallet.payer, tokenAccountKeypair]);

    console.log("User Token Account created:", userTokenAccount.toString());
    console.log("Balance: 0 MILK (you need to acquire MILK tokens to play)");
  }

  // Find user's farm PDA
  const [farmPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("farm"), wallet.publicKey.toBuffer()],
    program.programId
  );

  console.log("\n=== User Setup Complete ===");
  console.log("User:", wallet.publicKey.toString());
  console.log("Token Account:", userTokenAccount.toString());
  console.log("Farm PDA:", farmPda.toString());

  console.log("\n💡 To play the game:");
  console.log("1. Acquire MILK tokens and send them to your token account");
  console.log("2. Use the game interface to buy cows and earn rewards");
  console.log("3. Run 'yarn check-status' to monitor your progress");
}

main().catch((error) => {
  console.error("User setup failed:", error);
  process.exit(1);
});