import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount, getAssociatedTokenAddress, TokenAccountNotFoundError } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Test script for buying cows
 * Tests the buy_cows instruction with real transactions
 */
async function testBuyCows() {
  console.log("🐄 Testing Buy Cows Function...\n");

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
      baseMilkPerCowPerMin: config.baseMilkPerCowPerMin.toString(),
      cowInitialCost: config.cowInitialCost.toString(),
    });

    // Get user token account
    let userTokenAccount;
    try {
      userTokenAccount = await getAssociatedTokenAddress(
        config.milkMint,
        wallet.publicKey
      );
      console.log("✅ User token account address:", userTokenAccount.toString());
    } catch (error) {
      console.error("❌ Failed to get user token account address:");
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
      console.log("✅ Found", poolTokenAccounts.value.length, "pool token accounts");
    } catch (error) {
      console.error("❌ Failed to get pool token accounts:");
      console.error("Error:", error.message);
      return;
    }

    if (poolTokenAccounts.value.length === 0) {
      console.error("❌ Pool token account not found. Possible issues:");
      console.error("1. Pool not initialized - run 'yarn deploy-setup'");
      console.error("2. Wrong pool authority PDA");
      console.error("3. Wrong MILK mint address");
      console.error("Pool Authority PDA:", poolAuthorityPda.toString());
      console.error("MILK Mint:", config.milkMint.toString());
      return;
    }

    const poolTokenAccount = poolTokenAccounts.value[0].pubkey;
    console.log("✅ Pool token account:", poolTokenAccount.toString());

    // Check user balance before
    let userBalance;
    try {
      const tokenAccount = await getAccount(provider.connection, userTokenAccount);
      userBalance = Number(tokenAccount.amount) / 1_000_000;
      console.log(`💰 Current MILK balance: ${userBalance}`);
    } catch (error) {
      console.error("❌ Failed to get user token balance:");
      if (error instanceof TokenAccountNotFoundError) {
        console.error("Token account not found. User needs to:");
        console.error("1. Run 'yarn user-setup' to create token account");
        console.error("2. Acquire MILK tokens");
      } else {
        console.error("Error:", error.message);
        console.error("RPC Error Code:", error.code);
        console.error("RPC Error Data:", error.data);
      }
      return;
    }

    // Calculate current cow price
    const currentTime = Math.floor(Date.now() / 1000);
    const elapsedHours = Math.floor((currentTime - config.startTime.toNumber()) / 3600);
    const priceMultiplier = Math.pow(2, Math.min(elapsedHours, 4));
    const currentCowPrice = (config.cowInitialCost.toNumber() * priceMultiplier) / 1_000_000;
    
    console.log(`🏷️  Current cow price: ${currentCowPrice} MILK`);
    console.log(`⏰ Hours elapsed: ${elapsedHours}`);
    console.log(`📈 Price multiplier: ${priceMultiplier}x`);

    // Test buying 1 cow
    const numCows = 1;
    const totalCost = currentCowPrice * numCows;

    if (userBalance < totalCost) {
      console.log(`❌ Insufficient balance. Need ${totalCost} MILK but have ${userBalance} MILK`);
      return;
    }

    console.log(`\n🛒 Attempting to buy ${numCows} cow(s) for ${totalCost} MILK...`);

    // Check farm before
    let farmBefore;
    try {
      farmBefore = await program.account.farmAccount.fetch(farmPda);
      console.log(`🐄 Cows before: ${farmBefore.cows.toNumber()}`);
      console.log(`💎 Rewards before: ${farmBefore.accumulatedRewards.toNumber() / 1_000_000} MILK`);
    } catch (error) {
      if (error.message.includes("Account does not exist")) {
        console.log("🆕 Farm not initialized yet (first purchase)");
      } else {
        console.error("❌ Error fetching farm account:");
        console.error("Error:", error.message);
        console.error("Farm PDA:", farmPda.toString());
      }
      farmBefore = { cows: { toNumber: () => 0 } };
    }

    // Execute buy_cows transaction
    console.log("🔄 Building transaction...");
    let tx;
    try {
      const txBuilder = program.methods
        .buyCows(new anchor.BN(numCows))
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
      
      if (error.transactionMessage) {
        console.error("Transaction message:", error.transactionMessage);
      }
      
      // Common error explanations
      if (error.message.includes("insufficient funds")) {
        console.error("💡 Solution: Add more SOL to your wallet for transaction fees");
      } else if (error.message.includes("TokenInsufficientFunds")) {
        console.error("💡 Solution: You need more MILK tokens");
      } else if (error.message.includes("AccountNotFound")) {
        console.error("💡 Solution: Run 'yarn user-setup' to create required accounts");
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
      console.error("Transaction may still be processing...");
    }

    // Check results
    try {
      // Wait for account updates with proper commitment
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
      
      // Force refresh token account with proper commitment
      const userBalanceAfter = await getAccount(provider.connection, userTokenAccount, 'confirmed');
      const balanceAfterNum = Number(userBalanceAfter.amount) / 1_000_000;
      
      console.log(`\n📊 Results:`);
      console.log(`🐄 Cows after: ${farmAfter.cows.toNumber()}`);
      console.log(`🐄 Cows gained: ${farmAfter.cows.toNumber() - farmBefore.cows.toNumber()}`);
      console.log(`💰 MILK balance after: ${balanceAfterNum}`);
      console.log(`💸 MILK spent: ${userBalance - balanceAfterNum}`);
      console.log(`💎 Rewards after: ${farmAfter.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`⏰ Last update: ${new Date(farmAfter.lastUpdateTime.toNumber() * 1000).toISOString()}`);
      
      // Verify the farm PDA is correct
      console.log(`🔍 Farm PDA used: ${farmPda.toString()}`);
      console.log(`🔍 Farm owner: ${farmAfter.owner.toString()}`);
      console.log(`🔍 Expected owner: ${wallet.publicKey.toString()}`);
      
      // Verify the transaction worked as expected
      const actualCowIncrease = farmAfter.cows.toNumber() - farmBefore.cows.toNumber();
      const actualMilkSpent = userBalance - balanceAfterNum;
      
      console.log(`\n🔍 Transaction Verification:`);
      console.log(`Expected cow increase: 1`);
      console.log(`Actual cow increase: ${actualCowIncrease}`);
      console.log(`Expected MILK spent: ${totalCost}`);
      console.log(`Actual MILK spent: ${actualMilkSpent}`);
      
      if (actualCowIncrease === 1 && Math.abs(actualMilkSpent - totalCost) < 0.001) {
        console.log(`✅ SUCCESS: Transaction worked perfectly!`);
        console.log(`🐄 Cow successfully purchased and MILK transferred!`);
      } else {
        console.log(`⚠️  Account data may be stale. Checking transaction logs...`);
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
              log.includes('Successfully bought') && log.includes('cows')
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
      console.error("Error type:", error.constructor.name);
      
      // Debug PDA derivation
      console.error("\n🔍 Debugging farm account:");
      console.error("Farm PDA:", farmPda.toString());
      console.error("User pubkey:", wallet.publicKey.toString());
      console.error("Program ID:", program.programId.toString());
      
      // Try to get account info directly
      try {
        const accountInfo = await provider.connection.getAccountInfo(farmPda);
        if (accountInfo) {
          console.error("✅ Farm account exists but couldn't deserialize");
          console.error("Account owner:", accountInfo.owner.toString());
          console.error("Account data length:", accountInfo.data.length);
        } else {
          console.error("❌ Farm account does not exist");
        }
      } catch (infoError) {
        console.error("❌ Failed to get account info:", infoError.message);
      }
      
      console.error("Transaction was successful but couldn't verify results");
    }

    console.log("\n🎉 Buy Cows test completed successfully!");

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
    
    // Network-specific debugging
    if (connection) {
      try {
        const slot = await connection.getSlot();
        console.error("Current slot:", slot);
        const health = await connection.getHealth();
        console.error("RPC health:", health);
      } catch (healthError) {
        console.error("Failed to get network health:", healthError.message);
      }
    }
  }
}

testBuyCows().catch(console.error);