import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import {
  createInitializeAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

// MILK token mint addresses
const MILK_MINT_DEVNET = new PublicKey("H5b47NLbNgTAAMpz3rZKAfcoJ2JdGWKcEuEK51ghCbbY");
const MILK_MINT_MAINNET = new PublicKey("H5b47NLbNgTAAMpz3rZKAfcoJ2JdGWKcEuEK51ghCbbY"); //change for mainnet

/**
 * Deployment setup script for MilkerFun
 * Run this after deploying the program to initialize everything
 */
async function main() {
  // Set up provider manually
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com");
  
  // Load wallet from default Solana CLI location
  const walletPath = `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );
  
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.milkerfun as Program<Milkerfun>;

  console.log("Program ID:", program.programId.toString());
  console.log("Wallet:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  // Get MILK mint based on cluster
  let milkMint: PublicKey;
  
  if (provider.connection.rpcEndpoint.includes('devnet')) {
    milkMint = MILK_MINT_DEVNET;
    console.log("Using MILK token on devnet");
  } else if (provider.connection.rpcEndpoint.includes('mainnet')) {
    milkMint = MILK_MINT_MAINNET;
    console.log("Using MILK token on mainnet");
  } else {
    throw new Error("Unsupported cluster. Use devnet or mainnet only.");
  }

  console.log("MILK Mint:", milkMint.toString());

  // Find PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), configPda.toBuffer()],
    program.programId
  );

  console.log("Config PDA:", configPda.toString());
  console.log("Pool Authority PDA:", poolAuthorityPda.toString());

  // Create pool token account manually since PDA needs special handling
  console.log("Creating pool token account...");
  
  // Use a regular token account instead of associated token account for PDA
  const poolTokenAccountKeypair = anchor.web3.Keypair.generate();
  const poolTokenAccount = poolTokenAccountKeypair.publicKey;
  
  // Calculate rent for token account
  const tokenAccountSpace = 165; // Standard token account size
  const rent = await provider.connection.getMinimumBalanceForRentExemption(tokenAccountSpace);
  
  // Create the token account transaction
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: poolTokenAccount,
    lamports: rent,
    space: tokenAccountSpace,
    programId: TOKEN_PROGRAM_ID,
  });
  
  const initializeAccountIx = createInitializeAccountInstruction(
    poolTokenAccount,
    milkMint,
    poolAuthorityPda,
    TOKEN_PROGRAM_ID
  );
  
  const transaction = new Transaction()
    .add(createAccountIx)
    .add(initializeAccountIx);
  
  await provider.sendAndConfirm(transaction, [wallet.payer, poolTokenAccountKeypair]);

  console.log("Pool Token Account:", poolTokenAccount.toString());

  // Initialize config
  console.log("Initializing config...");
  const tx = await program.methods
    .initializeConfig()
    .accountsPartial({
      milkMint: milkMint,
      admin: wallet.publicKey,
    })
    .rpc();

  console.log("Initialize config transaction:", tx);

  // Verify config
  const config = await program.account.config.fetch(configPda);
  console.log("\n=== Configuration ===");
  console.log("Admin:", config.admin.toString());
  console.log("MILK Mint:", config.milkMint.toString());
  console.log("Base Milk per Cow per Min:", config.baseMilkPerCowPerMin.toString());
  console.log("Cow Initial Cost:", config.cowInitialCost.toString());
  console.log("Start Time:", new Date(config.startTime.toNumber() * 1000).toISOString());

  console.log("\n=== Deployment Complete ===");
  console.log("Save these addresses for your frontend:");
  console.log("Program ID:", program.programId.toString());
  console.log("MILK Mint:", milkMint.toString());
  console.log("Config PDA:", configPda.toString());
  console.log("Pool Authority PDA:", poolAuthorityPda.toString());
  console.log("Pool Token Account:", poolTokenAccount.toString());

  console.log("\n⚠️  NEXT STEPS:");
  console.log("1. Fund the pool token account with MILK tokens using 'yarn fund-pool <amount>'");
  console.log("2. Users can run 'yarn user-setup' to create their token accounts");
  console.log("3. Run 'yarn check-status' to verify everything is working");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});