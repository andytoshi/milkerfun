import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { setAuthority, AuthorityType } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Transfer COW mint authority from admin to PDA using SPL Token instructions
 * Run this AFTER deploy-setup to enable export/import functionality
 * Make sure you created the COW token externally with admin as mint authority first
 */
async function main() {
  // Set up provider manually
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

  console.log("=== Transfer COW Mint Authority ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  try {
    // Get config PDA
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [cowMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cow_mint_authority"), configPda.toBuffer()],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    
    // Verify admin access
    if (!config.admin.equals(wallet.publicKey)) {
      console.error("❌ Access denied: Only admin can transfer COW mint authority");
      console.error("Admin:", config.admin.toString());
      console.error("Your key:", wallet.publicKey.toString());
      process.exit(1);
    }

    console.log("✅ Admin access verified");
    console.log("COW Mint:", config.cowMint.toString());
    console.log("COW Mint Authority PDA:", cowMintAuthorityPda.toString());

    // Verify COW mint exists and admin is current authority
    try {
      const { getMint } = await import("@solana/spl-token");
      const cowMintInfo = await getMint(provider.connection, config.cowMint);
      
      console.log("✅ COW mint found");
      console.log("Current mint authority:", cowMintInfo.mintAuthority?.toString() || "null");
      console.log("Current freeze authority:", cowMintInfo.freezeAuthority?.toString() || "null");
      
      if (!cowMintInfo.mintAuthority?.equals(wallet.publicKey)) {
        console.error("❌ Admin is not the current mint authority");
        console.error("Expected:", wallet.publicKey.toString());
        console.error("Actual:", cowMintInfo.mintAuthority?.toString() || "null");
        console.error("💡 Make sure you created the COW token with admin as mint authority");
        process.exit(1);
      }
      
      console.log("✅ Admin is current mint authority");
    } catch (error) {
      console.error("❌ Failed to verify COW mint:");
      console.error("Error:", error.message);
      console.error("💡 Make sure the COW mint address in deploy-setup.ts is correct");
      process.exit(1);
    }

    console.log("\n🔄 Transferring COW mint authority from admin to PDA...");

    // Transfer mint authority using SPL Token instruction
    const mintAuthorityTx = await setAuthority(
      provider.connection,
      wallet.payer,
      config.cowMint,
      wallet.publicKey,
      AuthorityType.MintTokens,
      cowMintAuthorityPda
    );

    console.log("✅ Mint authority transfer transaction:", mintAuthorityTx);

    // Transfer freeze authority using SPL Token instruction
    const freezeAuthorityTx = await setAuthority(
      provider.connection,
      wallet.payer,
      config.cowMint,
      wallet.publicKey,
      AuthorityType.FreezeAccount,
      cowMintAuthorityPda
    );

    console.log("✅ Freeze authority transfer transaction:", freezeAuthorityTx);
    console.log("🔗 Mint Authority Explorer:", `https://explorer.solana.com/tx/${mintAuthorityTx}?cluster=devnet`);
    console.log("🔗 Freeze Authority Explorer:", `https://explorer.solana.com/tx/${freezeAuthorityTx}?cluster=devnet`);

    // Wait for confirmation
    await provider.connection.confirmTransaction(mintAuthorityTx, 'confirmed');
    await provider.connection.confirmTransaction(freezeAuthorityTx, 'confirmed');
    console.log("✅ Transactions confirmed");

    // Verify the transfer worked
    try {
      const { getMint } = await import("@solana/spl-token");
      const cowMintInfoAfter = await getMint(provider.connection, config.cowMint);
      
      console.log("\n=== Verification ===");
      console.log("New mint authority:", cowMintInfoAfter.mintAuthority?.toString() || "null");
      console.log("New freeze authority:", cowMintInfoAfter.freezeAuthority?.toString() || "null");
      
      if (cowMintInfoAfter.mintAuthority?.equals(cowMintAuthorityPda)) {
        console.log("✅ Mint authority successfully transferred to PDA");
      } else {
        console.log("⚠️  Mint authority transfer may not have completed properly");
      }

      if (cowMintInfoAfter.freezeAuthority?.equals(cowMintAuthorityPda)) {
        console.log("✅ Freeze authority successfully transferred to PDA");
      } else {
        console.log("⚠️  Freeze authority transfer may not have completed properly");
      }
    } catch (error) {
      console.log("⚠️  Could not verify authority transfer:", error.message);
    }

    console.log("\n=== Authority Transfer Complete ===");
    console.log("✅ COW mint authority transferred to PDA");
    console.log("✅ Export/Import functionality now enabled");

    console.log("\n🎉 Setup Complete! Your protocol now supports:");
    console.log("✅ Buying cows with MILK tokens");
    console.log("✅ Earning MILK rewards from cows");
    console.log("✅ Compounding rewards into more cows");
    console.log("✅ Withdrawing MILK rewards");
    console.log("✅ Exporting cows to tradeable COW tokens");
    console.log("✅ Importing COW tokens back to farming cows");

    console.log("\n💡 Test your protocol:");
    console.log("yarn test-buy      # Buy cows");
    console.log("yarn test-compound # Compound rewards");
    console.log("yarn test-withdraw # Withdraw rewards");
    console.log("yarn test-export   # Export to COW tokens");
    console.log("yarn test-import   # Import COW tokens back");

  } catch (error) {
    console.error("❌ Authority transfer failed:", error.message);
    
    console.log("\n💡 Troubleshooting:");
    console.log("1. Make sure you created the COW token externally with admin authority");
    console.log("2. Update COW_MINT addresses in deploy-setup.ts with correct mint address");
    console.log("3. Verify admin wallet has SOL for transaction fees");
    console.log("4. Ensure COW mint authority is still admin (not already transferred)");
    
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Authority transfer failed:", error);
  process.exit(1);
});