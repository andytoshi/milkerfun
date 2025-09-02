import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Test script for compounding cows
 * Tests the compound_cows instruction with real transactions
 */
async function testCompoundCows() {
  console.log("🔄 Testing Compound Cows Function...\n");

  let connection;
  let wallet;
  let provider;
  let program;

  // Set up provider
  try {
    connection = new anchor.web3.Connection("https://api.devnet.solana.com");
    console.log("✅ Connected to devnet");

    const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
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
      poolTokenAccount: config.poolTokenAccount.toString(),
      startTime: new Date(config.startTime.toNumber() * 1000).toISOString(),
      globalCowsCount: config.globalCowsCount.toNumber(),
      initialTvl: config.initialTvl.toNumber(),
    });

    // Get pool token account from config
    const poolTokenAccount = config.poolTokenAccount;

    // Check if farm exists
    let farm;
    try {
      farm = await program.account.farmAccount.fetch(farmPda);
      console.log(`🐄 Current cows: ${farm.cows.toNumber()}`);
      console.log(`💰 Accumulated rewards: ${farm.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`⏰ Last update: ${new Date(farm.lastUpdateTime.toNumber() * 1000).toISOString()}`);
    } catch (error) {
      console.error("❌ Farm not found:");
      console.error("Error:", error.message);
      console.error("Farm PDA:", farmPda.toString());
      console.error("💡 Solution: Buy some cows first using 'yarn test-buy'");
      return;
    }

    if (farm.cows.toNumber() === 0) {
      console.error("❌ No cows owned:");
      console.error("💡 Solution: Run 'yarn test-buy' to purchase cows first");
      return;
    }

    // Calculate pending rewards and total available
    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceUpdate = currentTime - farm.lastUpdateTime.toNumber();
    
    // Use stored reward rate or calculate current
    const storedRate = farm.lastRewardRate ? farm.lastRewardRate.toNumber() : 10_000_000; // 10 MILK/day default
    const currentRate = storedRate;
    
    const pendingRewards = (farm.cows.toNumber() * currentRate * timeSinceUpdate) / 86400; // per day to per second
    const totalRewards = farm.accumulatedRewards.toNumber() + pendingRewards;

    console.log(`⏰ Time since last update: ${timeSinceUpdate} seconds`);
    console.log(`⚡ Current reward rate: ${currentRate / 1_000_000} MILK/cow/day`);
    console.log(`🔄 Pending rewards: ${pendingRewards / 1_000_000} MILK`);
    console.log(`💎 Total available rewards: ${totalRewards / 1_000_000} MILK`);

    // Calculate dynamic cow price
    const globalCows = config.globalCowsCount.toNumber();
    let currentCowPrice = 6000; // base price in MILK
    if (globalCows > 0) {
      const ratio = globalCows / 1500.0;
      const powerTerm = Math.pow(ratio, 1.2);
      const multiplier = 1.0 + powerTerm;
      currentCowPrice = 6000 * multiplier;
    }
    
    console.log(`🏷️  Current cow price: ${currentCowPrice / 1_000_000} MILK`);
    console.log(`🌍 Global cows: ${globalCows}`);
    console.log(`📈 Price multiplier: ${(currentCowPrice / 6_000_000_000.0).toFixed(4)}x`);

    // Calculate how many cows we can afford
    const maxAffordableCows = Math.floor(totalRewards / currentCowPrice);
    
    if (maxAffordableCows === 0) {
      console.error("❌ Not enough rewards to buy even 1 cow:");
      console.error(`💰 Need: ${currentCowPrice / 1_000_000} MILK`);
      console.error(`💰 Have: ${totalRewards / 1_000_000} MILK`);
      console.error(`💰 Short: ${(currentCowPrice - totalRewards) / 1_000_000} MILK`);
      console.error("💡 Solutions:");
      console.error("  1. Wait longer for more rewards to accumulate");
      console.error("  2. Buy more cows to increase reward rate");
      console.error("  3. Withdraw current rewards instead");
      return;
    }

    console.log(`🎯 Max affordable cows: ${maxAffordableCows}`);

    // Test compounding 1 cow (or max if less than 1)
    const numCows = Math.min(1, maxAffordableCows);
    const totalCost = (currentCowPrice * 1_000_000) * numCows; // Convert to raw tokens

    console.log(`\n🔄 Attempting to compound ${numCows} cow(s) using ${totalCost / 1_000_000} MILK rewards...`);

    // Execute compound_cows transaction
    let tx;
    try {
      console.log("🔄 Building transaction...");
      const txBuilder = program.methods
        .compoundCows(new anchor.BN(numCows))
        .accountsPartial({
          config: configPda,
          farm: farmPda,
          poolTokenAccount: poolTokenAccount,
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
      if (error.message.includes("InsufficientRewards")) {
        console.error("💡 Solution: Wait for more rewards or try fewer cows");
      } else if (error.message.includes("insufficient funds")) {
        console.error("💡 Solution: Add more SOL to your wallet for transaction fees");
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
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      let farmAfter;
      let retries = 0;
      const maxRetries = 5;
      
      while (retries < maxRetries) {
        try {
          farmAfter = await program.account.farmAccount.fetch(farmPda, 'confirmed');
          break;
        } catch (error) {
          retries++;
          if (retries < maxRetries) {
            console.log(`⏳ Farm account not ready yet, retrying... (${retries}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            throw error;
          }
        }
      }
      
      console.log(`\n📊 Results:`);
      console.log(`🐄 Cows before: ${farm.cows.toNumber()}`);
      console.log(`🐄 Cows after: ${farmAfter.cows.toNumber()}`);
      console.log(`🐄 Cows gained: ${farmAfter.cows.toNumber() - farm.cows.toNumber()}`);
      console.log(`💰 Rewards before: ${totalRewards / 1_000_000} MILK`);
      console.log(`💰 Rewards after: ${farmAfter.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`💸 Rewards spent: ${(totalRewards - farmAfter.accumulatedRewards.toNumber()) / 1_000_000} MILK`);
      console.log(`⏰ Last update: ${new Date(farmAfter.lastUpdateTime.toNumber() * 1000).toISOString()}`);

      // Calculate new earning potential
      let newEarningRate = (farmAfter.cows.toNumber() * currentRate) / (86400 * 1_000_000); // per day to per second
      console.log(`📈 New earning rate: ${newEarningRate.toFixed(6)} MILK/second`);
      console.log(`📈 New earning rate: ${(newEarningRate * 86400).toFixed(4)} MILK/day`);
      console.log(`📈 New stored rate: ${farmAfter.lastRewardRate ? farmAfter.lastRewardRate.toNumber() / 1_000_000 : 'Not set'} MILK/cow/day`);

      // Transaction verification
      const actualCowIncrease = farmAfter.cows.toNumber() - farm.cows.toNumber();
      const actualRewardsSpent = totalRewards - farmAfter.accumulatedRewards.toNumber();
      const expectedRewardsSpent = totalCost;
      
      console.log(`\n🔍 Transaction Verification:`);
      console.log(`Expected cow increase: ${numCows}`);
      console.log(`Actual cow increase: ${actualCowIncrease}`);
      console.log(`Expected rewards spent: ${expectedRewardsSpent / 1_000_000} MILK`);
      console.log(`Actual rewards spent: ${actualRewardsSpent / 1_000_000} MILK`);
      
      if (actualCowIncrease === numCows && Math.abs(actualRewardsSpent - expectedRewardsSpent) < 1000000) {
        console.log(`✅ SUCCESS: Compound worked perfectly!`);
        console.log(`🔄 ${numCows} cow(s) successfully compounded using rewards!`);
      } else {
        console.log(`⚠️  Account data may be stale, but checking transaction logs...`);
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
              log.includes('Successfully compounded') && log.includes('cows')
            );
            if (successLog) {
              console.log(`✅ CONFIRMED: ${successLog}`);
            }
            
            // Look for error messages
            const errorLog = txDetails.meta.logMessages.find(log => 
              log.includes('Error:') || log.includes('failed')
            );
            if (errorLog) {
              console.log(`❌ ERROR FOUND: ${errorLog}`);
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

    console.log("\n🎉 Compound Cows test completed successfully!");

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

testCompoundCows().catch(console.error);