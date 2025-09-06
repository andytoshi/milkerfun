import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Transfer COW mint authority from admin to PDA
 * Run this AFTER setup-cow-metadata to enable export/import functionality
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

    console.log("\n🔄 Transferring COW mint authority from admin to PDA...");

    // Execute transfer_cow_mint_authority transaction
    const tx = await program.methods
      .transferCowMintAuthority()
      .accountsPartial({
        config: configPda,
        cowMint: config.cowMint,
        cowMintAuthority: cowMintAuthorityPda,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("✅ Authority transfer transaction:", tx);
    console.log("🔗 Explorer:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);

    // Wait for confirmation
    await provider.connection.confirmTransaction(tx, 'confirmed');
    console.log("✅ Transaction confirmed");

    console.log("\n=== Authority Transfer Complete ===");
    console.log("✅ COW mint authority transferred to PDA");
    console.log("✅ Export/Import functionality now enabled");
    console.log("✅ Metadata preserved and immutable");

    console.log("\n🎉 Setup Complete! Your protocol now supports:");
    console.log("✅ Buying cows with MILK tokens");
    console.log("✅ Earning MILK rewards from cows");
    console.log("✅ Compounding rewards into more cows");
    console.log("✅ Withdrawing MILK rewards");
    console.log("✅ Exporting cows to tradeable COW tokens");
    console.log("✅ Importing COW tokens back to farming cows");
    console.log("✅ Proper token metadata for DEX listings");

    console.log("\n💡 Test your protocol:");
    console.log("yarn test-buy      # Buy cows");
    console.log("yarn test-compound # Compound rewards");
    console.log("yarn test-withdraw # Withdraw rewards");
    console.log("yarn test-export   # Export to COW tokens");
    console.log("yarn test-import   # Import COW tokens back");

  } catch (error) {
    console.error("❌ Authority transfer failed:", error.message);
    if (error.logs) {
      error.logs.forEach(log => console.error(log));
    }
    
    console.log("\n💡 Troubleshooting:");
    console.log("1. Make sure you ran 'yarn setup-cow-metadata' first");
    console.log("2. Verify admin wallet has SOL for transaction fees");
    console.log("3. Ensure COW mint authority is still admin (not already transferred)");
    
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Authority transfer failed:", error);
  process.exit(1);
});