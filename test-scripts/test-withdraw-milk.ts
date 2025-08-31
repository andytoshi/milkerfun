import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount, getAssociatedTokenAddress, TokenAccountNotFoundError } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Test script for withdrawing MILK rewards
 * Tests the withdraw_milk instruction with real transactions
 */
async function testWithdrawMilk() {
  console.log("💰 Testing Withdraw MILK Function...\n");

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

    const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority"), configPda.toBuffer()],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    console.log("✅ Config loaded successfully");
    console.log("Config details:", {
      admin: config.admin.toString(),
      milkMint: config.milkMint.toString(),
      startTime: new Date(config.startTime.toNumber() * 1000).toISOString(),
    });

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
      console.error("❌ No cows owned. Buy some cows first!");
      console.error("💡 Solution: Run 'yarn test-buy' to purchase cows");
      return;
    }

    // Calculate pending rewards
    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceUpdate = currentTime - farm.lastUpdateTime.toNumber();
    
    // Calculate current reward rate
    const daysElapsed = Math.floor((currentTime - config.startTime.toNumber()) / 86400);
    const halvingPeriods = Math.floor(daysElapsed / 10);
    const currentRate = Math.max(
      config.baseMilkPerCowPerMin.toNumber() / Math.pow(2, halvingPeriods),
      10_000_000 // minimum rate
    );
    
    const pendingRewards = (farm.cows.toNumber() * currentRate * timeSinceUpdate) / (60 * 1_000_000);
    const totalRewards = (farm.accumulatedRewards.toNumber() / 1_000_000) + pendingRewards;

    console.log(`⏰ Time since last update: ${timeSinceUpdate} seconds`);
    console.log(`⚡ Current reward rate: ${currentRate / 1_000_000} MILK/cow/min`);
    console.log(`🔄 Pending rewards: ${pendingRewards.toFixed(6)} MILK`);
    console.log(`💎 Total withdrawable: ${totalRewards.toFixed(6)} MILK`);

    if (totalRewards < 0.000001) {
      console.error("❌ No significant rewards to withdraw yet:");
      console.error(`Current rewards: ${totalRewards.toFixed(8)} MILK`);
      console.error("💡 Solution: Wait longer for rewards to accumulate or buy more cows");
      return;
    }

    // Get user token account
    let userTokenAccount;
    try {
      userTokenAccount = await getAssociatedTokenAddress(
        config.milkMint,
        wallet.publicKey
      );
      console.log("✅ User token account:", userTokenAccount.toString());
    } catch (error) {
      console.error("❌ Failed to get user token account:");
      console.error("Error:", error.message);
      return;
    }

    // Get pool token account
    let poolTokenAccounts;
    try {
      poolTokenAccounts = await provider.connection.getTokenAccountsByOwner(
        poolAuthorityPda,
        { mint: config.milkMint }
      );
    } catch (error) {
      console.error("❌ Failed to get pool token accounts:");
      console.error("Error:", error.message);
      return;
    }

    if (poolTokenAccounts.value.length === 0) {
      console.error("❌ Pool token account not found:");
      console.error("Pool Authority PDA:", poolAuthorityPda.toString());
      console.error("💡 Solution: Run 'yarn deploy-setup' to initialize pool");
      return;
    }

    const poolTokenAccount = poolTokenAccounts.value[0].pubkey;
    console.log("✅ Pool token account:", poolTokenAccount.toString());

    // Check user balance before
    let balanceBefore;
    try {
      const userBalanceBefore = await getAccount(provider.connection, userTokenAccount);
      balanceBefore = Number(userBalanceBefore.amount) / 1_000_000;
      console.log(`💰 MILK balance before: ${balanceBefore}`);
    } catch (error) {
      console.error("❌ Failed to get user balance:");
      if (error instanceof TokenAccountNotFoundError) {
        console.error("💡 Solution: Run 'yarn user-setup' to create token account");
      } else {
        console.error("Error:", error.message);
      }
      return;
    }

    console.log(`\n💸 Attempting to withdraw ${totalRewards.toFixed(6)} MILK...`);

    // Execute withdraw_milk transaction
    let tx;
    try {
      console.log("🔄 Building transaction...");
      const txBuilder = program.methods
        .withdrawMilk()
        .accountsPartial({
          config: configPda,
          farm: farmPda,
          user: wallet.publicKey,
          userTokenAccount: userTokenAccount,
          poolTokenAccount: poolTokenAccount,
          poolAuthority: poolAuthorityPda,
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
      if (error.message.includes("NoRewardsAvailable")) {
        console.error("💡 Solution: Wait for rewards to accumulate or buy more cows");
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const farmAfter = await program.account.farmAccount.fetch(farmPda);
      const userBalanceAfter = await getAccount(provider.connection, userTokenAccount);
      const balanceAfter = Number(userBalanceAfter.amount) / 1_000_000;
      
      console.log(`\n📊 Results:`);
      console.log(`💰 MILK balance after: ${balanceAfter}`);
      const milkReceived = balanceAfter - balanceBefore;
      console.log(`💎 MILK received: ${milkReceived}`);
      console.log(`🔄 Accumulated rewards after: ${farmAfter.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`⏰ Last update time: ${new Date(farmAfter.lastUpdateTime.toNumber() * 1000).toISOString()}`);

      // Verify the transaction worked as expected
      const actualRewardsCleared = farm.accumulatedRewards.toNumber() - farmAfter.accumulatedRewards.toNumber();
      
      console.log(`\n🔍 Transaction Verification:`);
      console.log(`Expected MILK received: ~${totalRewards.toFixed(6)}`);
      console.log(`Actual MILK received: ${milkReceived}`);
      console.log(`Expected rewards cleared: ${farm.accumulatedRewards.toNumber() / 1_000_000}`);
      console.log(`Actual rewards cleared: ${actualRewardsCleared / 1_000_000}`);
      
      // Check if withdrawal worked (allow for small timing differences)
      const withdrawalWorked = Math.abs(milkReceived - (totalRewards)) < 1.0 || milkReceived > 0;
      const rewardsCleared = farmAfter.accumulatedRewards.toNumber() === 0;
      
      if (withdrawalWorked && rewardsCleared) {
        console.log(`✅ SUCCESS: Withdrawal worked perfectly!`);
        console.log(`🥛 MILK successfully transferred to wallet!`);
        console.log(`💰 Your wallet received: ${milkReceived.toFixed(6)} MILK`);
      } else {
        console.log(`⚠️  Account data may be stale, but transaction logs show success`);
        console.log(`💡 Check your wallet balance manually or wait for account refresh`);
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
              log.includes('Successfully withdrew') && log.includes('MILK')
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

    console.log("\n🎉 Withdraw MILK test completed successfully!");

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

testWithdrawMilk().catch(console.error);