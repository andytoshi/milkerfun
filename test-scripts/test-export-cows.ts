import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Test script for exporting cows to COW tokens
 * Tests the export_cows instruction with real transactions
 */
async function testExportCows() {
  console.log("📤 Testing Export Cows Function...\n");

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

    const [cowMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cow_mint_authority"), configPda.toBuffer()],
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

    // Check if COW token account exists, create if needed
    let cowTokenAccountExists = false;
    let cowBalanceBefore = 0;
    try {
      const cowTokenAccount = await getAccount(provider.connection, userCowTokenAccount);
      cowBalanceBefore = Number(cowTokenAccount.amount);
      cowTokenAccountExists = true;
      console.log(`💰 Current COW token balance: ${cowBalanceBefore}`);
    } catch (error) {
      console.log("🆕 COW token account doesn't exist yet, will create it");
    }

    // Test exporting 1 cow
    const numCows = Math.min(1, farm.cows.toNumber());
    console.log(`\n📤 Attempting to export ${numCows} cow(s) to COW tokens...`);

    // Build transaction
    let tx;
    try {
      console.log("🔄 Building transaction...");
      
      const txBuilder = program.methods
        .exportCows(new anchor.BN(numCows));

      // Add create ATA instruction if needed
      if (!cowTokenAccountExists) {
        console.log("🔄 Adding create COW token account instruction...");
        const createAtaIx = createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userCowTokenAccount,
          wallet.publicKey,
          config.cowMint
        );
        txBuilder.preInstructions([createAtaIx]);
      }

      const txBuilderWithAccounts = txBuilder.accountsPartial({
        config: configPda,
        farm: farmPda,
        cowMint: config.cowMint,
        cowMintAuthority: cowMintAuthorityPda,
        userCowTokenAccount: userCowTokenAccount,
        poolTokenAccount: config.poolTokenAccount,
        user: wallet.publicKey,
      });

      console.log("🔄 Sending transaction...");
      tx = await txBuilderWithAccounts.rpc({
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
      if (error.message.includes("InsufficientCows")) {
        console.error("💡 Solution: You don't have enough cows to export");
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
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const farmAfter = await program.account.farmAccount.fetch(farmPda, 'confirmed');
      const cowTokenAccountAfter = await getAccount(provider.connection, userCowTokenAccount, 'confirmed');
      const cowBalanceAfter = Number(cowTokenAccountAfter.amount);
      
      console.log(`\n📊 Results:`);
      console.log(`🐄 Cows before: ${farm.cows.toNumber()}`);
      console.log(`🐄 Cows after: ${farmAfter.cows.toNumber()}`);
      console.log(`🐄 Cows exported: ${farm.cows.toNumber() - farmAfter.cows.toNumber()}`);
      console.log(`🪙 COW tokens before: ${cowBalanceBefore}`);
      console.log(`🪙 COW tokens after: ${cowBalanceAfter}`);
      console.log(`🪙 COW tokens received: ${cowBalanceAfter - cowBalanceBefore}`);
      console.log(`💰 Accumulated rewards: ${farmAfter.accumulatedRewards.toNumber() / 1_000_000} MILK`);
      console.log(`⏰ Last update: ${new Date(farmAfter.lastUpdateTime.toNumber() * 1000).toISOString()}`);

      // Transaction verification
      const actualCowDecrease = farm.cows.toNumber() - farmAfter.cows.toNumber();
      const actualCowTokensReceived = cowBalanceAfter - cowBalanceBefore;
      
      console.log(`\n🔍 Transaction Verification:`);
      console.log(`Expected cow decrease: ${numCows}`);
      console.log(`Actual cow decrease: ${actualCowDecrease}`);
      console.log(`Expected COW tokens received: ${numCows}`);
      console.log(`Actual COW tokens received: ${actualCowTokensReceived}`);
      
      if (actualCowDecrease === numCows && actualCowTokensReceived === numCows) {
        console.log(`✅ SUCCESS: Export worked perfectly!`);
        console.log(`📤 ${numCows} cow(s) successfully exported to COW tokens!`);
      } else {
        console.log(`⚠️  Account data may be stale, checking transaction logs...`);
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
              log.includes('Successfully exported') && log.includes('cows')
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

    console.log("\n🎉 Export Cows test completed successfully!");
    console.log("\n💡 Next steps:");
    console.log("1. Your COW tokens can now be traded on DEXs");
    console.log("2. Use 'yarn test-import' to convert COW tokens back to cows");
    console.log("3. Check COW token supply to see total exported cows");

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

testExportCows().catch(console.error);