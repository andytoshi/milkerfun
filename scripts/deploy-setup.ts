import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import {
  createInitializeAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

// MILK token mint addresses
const MILK_MINT_DEVNET = new PublicKey("ErGaHLayDmovrt2ttBrwmrrYyjuaqojABWEuPiYgtZvj");
const MILK_MINT_MAINNET = new PublicKey("11111111111111111111111111111111"); //change for mainnet

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

  const [cowMintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("cow_mint_authority"), configPda.toBuffer()],
    program.programId
  );

  console.log("Config PDA:", configPda.toString());
  console.log("Pool Authority PDA:", poolAuthorityPda.toString());
  console.log("COW Mint Authority PDA:", cowMintAuthorityPda.toString());

  const [cowMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("cow_mint"), configPda.toBuffer()],
    program.programId
  );

  console.log("COW Mint PDA:", cowMintPda.toString());


  // Check if pool token account already exists
  let poolTokenAccount: PublicKey;
  
  const existingPoolAccounts = await provider.connection.getTokenAccountsByOwner(
    poolAuthorityPda,
    { mint: milkMint }
  );

  if (existingPoolAccounts.value.length > 0) {
    poolTokenAccount = existingPoolAccounts.value[0].pubkey;
    console.log("✅ Found existing pool token account:", poolTokenAccount.toString());
    
    // Verify it's properly initialized with retry logic
    let existingAccountVerified = false;
    let verificationAttempts = 0;
    const maxVerificationAttempts = 5;
    
    while (!existingAccountVerified && verificationAttempts < maxVerificationAttempts) {
      try {
        const accountInfo = await provider.connection.getAccountInfo(poolTokenAccount, 'finalized');
        if (accountInfo && accountInfo.data.length === 165) { // Standard token account size
          console.log("✅ Existing pool token account is properly initialized");
          existingAccountVerified = true;
          break;
        } else {
          throw new Error("Account not properly initialized or wrong size");
        }
      } catch (error) {
        verificationAttempts++;
        console.log(`⏳ Verifying existing account attempt ${verificationAttempts}/${maxVerificationAttempts}...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    if (!existingAccountVerified) {
      console.error("❌ Existing pool token account could not be verified");
      console.error("This might indicate the account is corrupted or not a proper token account");
      console.error("You may need to create a new deployment with a fresh pool account");
      throw new Error("Existing pool token account verification failed");
    }
  } else {
    // Create pool token account manually since PDA needs special handling
    console.log("Creating new pool token account...");
    
    // Use a regular token account instead of associated token account for PDA
    const poolTokenAccountKeypair = anchor.web3.Keypair.generate();
    poolTokenAccount = poolTokenAccountKeypair.publicKey;
    
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
    
    const createTxSignature = await provider.sendAndConfirm(transaction, [wallet.payer, poolTokenAccountKeypair]);
    console.log("Pool token account creation tx:", createTxSignature);

    // Wait for account to be confirmed on-chain with proper commitment
    console.log("Waiting for account confirmation...");
    await provider.connection.confirmTransaction(createTxSignature, 'finalized');
    console.log("✅ Pool token account transaction finalized");
    
    // Additional wait to ensure account is fully propagated
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Final verification before proceeding with multiple attempts
  let accountVerified = false;
  let verificationAttempts = 0;
  const maxVerificationAttempts = 10;
  
  while (!accountVerified && verificationAttempts < maxVerificationAttempts) {
    try {
      const accountInfo = await provider.connection.getAccountInfo(poolTokenAccount, 'finalized');
      if (accountInfo && accountInfo.data.length > 0) {
        console.log("✅ Pool token account verified and initialized");
        accountVerified = true;
        break;
      } else {
        throw new Error("Account not properly initialized");
      }
    } catch (error) {
      verificationAttempts++;
      console.log(`⏳ Verification attempt ${verificationAttempts}/${maxVerificationAttempts} - waiting for account...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  if (!accountVerified) {
    throw new Error("Pool token account could not be verified after multiple attempts");
  }

  console.log("Pool Token Account:", poolTokenAccount.toString());

  // Initialize config with proper error handling
  let tx;
  console.log("Initializing config with verified pool token account and COW mint with Token Extensions metadata...");
  try {
    tx = await program.methods
      .initializeConfig()
      .accountsPartial({
        config: configPda,
        milkMint: milkMint,
        cowMint: cowMintPda,
        cowMintAuthority: cowMintAuthorityPda,
        poolTokenAccount: poolTokenAccount,
        admin: wallet.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({
        commitment: 'finalized',
        preflightCommitment: 'finalized',
      });
      
    console.log("Initialize config transaction:", tx);
    
    // Wait for config transaction to be finalized
    await provider.connection.confirmTransaction(tx, 'finalized');
    console.log("✅ Config initialization transaction finalized");
    
  } catch (error) {
    console.error("❌ Failed to initialize config:");
    console.error("Error:", error.message);
    if (error.logs) {
      console.error("Program logs:");
      error.logs.forEach(log => console.error(`  ${log}`));
    }
    throw error;
  }


  // Wait for config account to be confirmed
  console.log("Waiting for config account to be available...");
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Verify config with retry logic
  let config;
  let retries = 0;
  const maxRetries = 5;
  
  while (retries < maxRetries) {
    try {
      config = await program.account.config.fetch(configPda, 'confirmed');
      console.log("✅ Config account confirmed");
      break;
    } catch (error) {
      retries++;
      if (retries < maxRetries) {
        console.log(`⏳ Config account not ready yet, retrying... (${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        console.log("⚠️  Could not fetch config for verification, but transaction succeeded");
        console.log("Transaction signature:", tx);
        console.log("Config should be available shortly. You can verify with 'yarn check-status'");
        return;
      }
    }
  }
  
  console.log("\n=== Configuration ===");
  console.log("Admin:", config.admin.toString());
  console.log("MILK Mint:", config.milkMint.toString());
  console.log("COW Mint:", config.cowMint.toString());
  console.log("Pool Token Account:", config.poolTokenAccount.toString());
  console.log("Start Time:", new Date(config.startTime.toNumber() * 1000).toISOString());
  console.log("Global Cows Count:", config.globalCowsCount.toString());
  console.log("Initial TVL:", config.initialTvl.toString());

  console.log("\n=== Deployment Complete ===");
  console.log("Save these addresses for your frontend:");
  console.log("Program ID:", program.programId.toString());
  console.log("MILK Mint:", milkMint.toString());
  console.log("COW Mint:", cowMintPda.toString());
  console.log("Config PDA:", configPda.toString());
  console.log("Pool Authority PDA:", poolAuthorityPda.toString());
  console.log("COW Mint Authority PDA:", cowMintAuthorityPda.toString());
  console.log("Pool Token Account:", poolTokenAccount.toString());

  console.log("\n⚠️  NEXT STEPS:");
  console.log("1. Fund the pool token account with MILK tokens using 'yarn fund-pool <amount>'");
  console.log("2. Users can run 'yarn user-setup' to create their token accounts");
  console.log("3. Run 'yarn setup-cow-metadata' to add token name, symbol, and image");
  console.log("4. Run 'yarn transfer-cow-authority' to enable export/import");
  console.log("5. Run 'yarn check-status' to verify everything is working");
  console.log("\n💡 Economic Model:");
  console.log("- Dynamic cow pricing based on global supply");
  console.log("- Dynamic rewards based on TVL/Cow ratio");
  console.log("- Early adopter greed boost that decays over time");
  console.log("- Anti-dump mechanism: lower TVL = higher rewards");
  console.log("\n💡 COW Token Behavior (after metadata setup):");
  console.log("- Appears as SPL token with name 'MilkerFun COW' and symbol 'COW'");
  console.log("- Shows cow image in wallet");
  console.log("- No NFT/collectible behavior (no collection)");
  console.log("- Fully tradeable on DEXs");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});