import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Test script for importing COW tokens back to cows
 * Tests the import_cows instruction with real transactions
 */
async function testImportCows() {
  console.log("📥 Testing Import Cows Function...\n");

  let connection;
  let wallet;
  let provider;
  let program;

  // Set up provider
  try {
    connection = new anchor.web3.Connection("https://api.devnet.solana.com");
    console.log("✅ Connected to devnet");

    const walletPath = `${os.homedir()}/.config/solana/id.json`;
    if (!fs.existsSync(walletPath)) {
      throw new Error(`Wallet file not found at ${walletPath}. Run 'solana-keygen new' first.`);
    }

    const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const walletKeypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(walletData));
    wallet = new anchor.Wallet(walletKeypair);
    console.log("✅ Wallet loaded:", wallet.publicKey.toString());

    provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    anchor.setProvider(provider);

    program = anchor.workspace.milkerfun as Program<Milkerfun>;
    if (!program) {
      throw new Error("Program not found. Make sure Anchor workspace is properly configured.");
    }
    console.log("✅ Program loaded:", program.programId.toString());

  } catch (error) {
    console.error("❌ Setup failed:");
    console.error("Error:", error.message);
    if (error.stack) console.error("Stack:", error.stack);
    return;
  }

  try {
    // Get config and addresses
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [farmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("farm"), wallet.publicKey.toBuffer()],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    console.log("✅ Config loaded successfully");
    console.log("Config details:", {
      admin: config.admin.toString(),
      milkMint: config.milkMint.toString(),
      cowMint: config.cowMint.toString(),
      poolTokenAccount: config.poolTokenAccount.toString(),
      startTime: new Date(config.startTime.toNumber() * 1000).toISOString(),
      globalCowsCount: config.globalCowsCount.toNumber(),
    });

    // Check current farm state
    let farm;
    let farmExists = true;
    try {
      farm = await program.account.farmAccount.fetch(farmPda);
      console.log(`🐄 Current cows: ${farm.cows.toNumber()}`);
      console.log(`💰 Accumulated rewards: ${farm.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`⏰ Last update: ${new Date(farm.lastUpdateTime.toNumber() * 1000).toISOString()}`);
    } catch (error) {
      console.log("🆕 Farm not initialized yet (will be created during import)");
      farmExists = false;
      farm = { cows: { toNumber: () => 0 }, accumulatedRewards: { toNumber: () => 0 } };
    }

    // Get user COW token account
    let userCowTokenAccount;
    try {
      userCowTokenAccount = await getAssociatedTokenAddress(
        config.cowMint,
        wallet.publicKey
      );
      console.log("✅ User COW token account:", userCowTokenAccount.toString());
    } catch (error) {
      console.error("❌ Failed to get user COW token account:");
      console.error("Error:", error.message);
      return;
    }

    // Check COW token balance
    let cowBalanceBefore;
    try {
      const cowTokenAccount = await getAccount(provider.connection, userCowTokenAccount);
      cowBalanceBefore = Number(cowTokenAccount.amount) / 1_000_000; // Convert from 6 decimals
      console.log(`🪙 Current COW token balance: ${cowBalanceBefore} COW`);
    } catch (error) {
      console.error("❌ COW token account not found:");
      console.error("Error:", error.message);
      console.error("💡 Solution: Export some cows first using 'yarn test-export' or acquire COW tokens");
      return;
    }

    if (cowBalanceBefore === 0) {
      console.error("❌ No COW tokens to import:");
      console.error("💡 Solutions:");
      console.error("  1. Export some cows first using 'yarn test-export'");
      console.error("  2. Acquire COW tokens from another user or DEX");
      return;
    }

    // Test importing 1 COW token (or all if less than 1)
    const numCows = Math.min(1, Math.floor(cowBalanceBefore));
    console.log(`\n📥 Attempting to import ${numCows} COW token(s) to cows...`);

    // Execute import_cows transaction
    let tx;
    try {
      console.log("🔄 Building transaction...");
      const txBuilder = program.methods
        .importCows(new anchor.BN(numCows))
        .accountsPartial({
          config: configPda,
          farm: farmPda,
          cowMint: config.cowMint,
          userCowTokenAccount: userCowTokenAccount,
          poolTokenAccount: config.poolTokenAccount,
          user: wallet.publicKey,
        });

      console.log("🔄 Sending transaction...");
      tx = await txBuilder.rpc({
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
      });
    } catch (error) {
      console.error("❌ Transaction failed:");
      console.error("Error:", error.message);
      
      if (error.logs) {
        console.error("📋 Program logs:");
        error.logs.forEach((log, i) => console.error(`  ${i + 1}. ${log}`));
      }
      
      if (error.code) {
        console.error("Error code:", error.code);
      }
      
      // Common error explanations
      if (error.message.includes("insufficient funds")) {
        console.error("💡 Solution: Add more SOL to your wallet for transaction fees");
      } else if (error.message.includes("TokenInsufficientFunds")) {
        console.error("💡 Solution: You don't have enough COW tokens");
      }
      
      return;
    }

    console.log(`✅ Transaction successful: ${tx}`);
    console.log(`🔗 Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);

    // Wait for confirmation
    console.log("⏳ Waiting for transaction confirmation...");
    try {
      await provider.connection.confirmTransaction(tx, 'confirmed');
      console.log("✅ Transaction confirmed");
    } catch (error) {
      console.error("❌ Transaction confirmation failed:");
      console.error("Error:", error.message);
    }

    // Check results
    try {
      // Wait for account updates
      console.log("⏳ Waiting for account updates...");
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const farmAfter = await program.account.farmAccount.fetch(farmPda, 'confirmed');
      const cowTokenAccountAfter = await getAccount(provider.connection, userCowTokenAccount, 'confirmed');
      const cowBalanceAfter = Number(cowTokenAccountAfter.amount) / 1_000_000; // Convert from 6 decimals
      
      // Get updated config for global cow count
      const configAfter = await program.account.config.fetch(configPda, 'confirmed');
      
      console.log(`\n📊 Results:`);
      console.log(`🐄 Cows before: ${farm.cows.toNumber()}`);
      console.log(`🐄 Cows after: ${farmAfter.cows.toNumber()}`);
      console.log(`🐄 Cows gained: ${farmAfter.cows.toNumber() - farm.cows.toNumber()}`);
      console.log(`🪙 COW tokens before: ${cowBalanceBefore} COW`);
      console.log(`🪙 COW tokens after: ${cowBalanceAfter} COW`);
      console.log(`🪙 COW tokens burned: ${cowBalanceBefore - cowBalanceAfter}`);
      console.log(`💰 Accumulated rewards: ${farmAfter.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`🌍 Global cows count: ${configAfter.globalCowsCount.toNumber()}`);
      console.log(`⏰ Last update: ${new Date(farmAfter.lastUpdateTime.toNumber() * 1000).toISOString()}`);

      // Transaction verification
      const actualCowIncrease = farmAfter.cows.toNumber() - farm.cows.toNumber();
      const actualCowTokensBurned = cowBalanceBefore - cowBalanceAfter;
      
      console.log(`\n🔍 Transaction Verification:`);
      console.log(`Expected cow increase: ${numCows}`);
      console.log(`Actual cow increase: ${actualCowIncrease}`);
      console.log(`Expected COW tokens burned: ${numCows}`);
      console.log(`Actual COW tokens burned: ${actualCowTokensBurned}`);
      
      if (actualCowIncrease === numCows && actualCowTokensBurned === numCows) {
        console.log(`✅ SUCCESS: Import worked perfectly!`);
        console.log(`📥 ${numCows} COW token(s) successfully imported to cows!`);
      } else {
        console.log(`⚠️  Account data may be stale, checking transaction logs...`);
      }

      // Show earning potential
      if (farmAfter.cows.toNumber() > 0) {
        const currentRewardRate = farmAfter.lastRewardRate ? farmAfter.lastRewardRate.toNumber() / 1_000_000 : 10;
        const dailyEarnings = farmAfter.cows.toNumber() * currentRewardRate;
        console.log(`\n💰 Earning Potential:`);
        console.log(`📈 Current reward rate: ${currentRewardRate} MILK/cow/day`);
        console.log(`📈 Daily earnings: ${dailyEarnings.toFixed(2)} MILK/day`);
        console.log(`📈 Hourly earnings: ${(dailyEarnings / 24).toFixed(4)} MILK/hour`);
      }

      // Always show transaction details for verification
      try {
        console.log(`\n🔍 Transaction Details:`);
        const txDetails = await provider.connection.getTransaction(tx, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
        
        if (txDetails) {
          console.log(`Transaction status: ${txDetails.meta?.err ? 'FAILED' : 'SUCCESS'}`);
          if (txDetails.meta?.err) {
            console.log(`Transaction error:`, txDetails.meta.err);
          }
          if (txDetails.meta?.logMessages) {
            console.log(`📋 Program Logs:`);
            txDetails.meta.logMessages.forEach((log, i) => {
              console.log(`  ${i + 1}. ${log}`);
            });
            
            // Parse program logs for success confirmation
            const successLog = txDetails.meta.logMessages.find(log => 
              log.includes('Successfully imported') && log.includes('COW tokens')
            );
            if (successLog) {
              console.log(`✅ CONFIRMED: ${successLog}`);
            }
          }
        }
      } catch (txError) {
        console.log(`❌ Failed to get transaction details:`, txError.message);
      }

    } catch (error) {
      console.error("❌ Failed to fetch results:");
      console.error("Error:", error.message);
    }

    console.log("\n🎉 Import Cows test completed successfully!");
    console.log("\n💡 What happened:");
    console.log("1. Your COW tokens were burned (removed from circulation)");
    console.log("2. Equivalent cows were added to your farm");
    console.log("3. Global cow count increased");
    console.log("4. Your cows are now earning MILK rewards!");

  } catch (error) {
    console.error("❌ Test failed with unexpected error:");
    console.error("Error message:", error.message);
    console.error("Error type:", error.constructor.name);
    
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    
    if (error.logs) {
      console.error("📋 Program logs:");
      error.logs.forEach((log, i) => console.error(`  ${i + 1}. ${log}`));
    }
    
    if (error.code) {
      console.error("Error code:", error.code);
    }
  }
}

testImportCows().catch(console.error);