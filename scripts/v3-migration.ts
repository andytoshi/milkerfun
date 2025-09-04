import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Admin script for V3 migration (emergency withdrawal)
 * ADMIN ONLY - Withdraws all MILK from pool for protocol upgrade
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

  console.log("=== V3 Migration Tool ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  // Get config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), configPda.toBuffer()],
    program.programId
  );

  try {
    const config = await program.account.config.fetch(configPda);
    
    // Verify admin access
    if (!config.admin.equals(wallet.publicKey)) {
      console.error("❌ Access denied: Only admin can perform V3 migration");
      console.error("Admin:", config.admin.toString());
      console.error("Your key:", wallet.publicKey.toString());
      process.exit(1);
    }

    console.log("✅ Admin access verified");

    // Get pool balance
    const poolBalance = await getAccount(provider.connection, config.poolTokenAccount);
    const poolBalanceInMilk = Number(poolBalance.amount) / 1_000_000;

    console.log("\n=== Current Pool Status ===");
    console.log("Pool Token Account:", config.poolTokenAccount.toString());
    console.log("Pool Balance:", poolBalanceInMilk.toLocaleString(), "MILK");
    console.log("Raw Balance:", poolBalance.amount.toString());

    if (poolBalance.amount === BigInt(0)) {
      console.log("⚠️  Pool is already empty - no migration needed");
      return;
    }

    // Get admin token account
    const adminTokenAccount = await getAssociatedTokenAddress(
      config.milkMint,
      wallet.publicKey
    );

    console.log("Admin Token Account:", adminTokenAccount.toString());

    // Check admin balance before
    let adminBalanceBefore;
    try {
      const adminBalance = await getAccount(provider.connection, adminTokenAccount);
      adminBalanceBefore = Number(adminBalance.amount) / 1_000_000;
      console.log("Admin Balance Before:", adminBalanceBefore.toLocaleString(), "MILK");
    } catch (error) {
      console.error("❌ Admin token account not found. Run user-setup first.");
      process.exit(1);
    }

    // Confirm migration
    console.log("\n⚠️  WARNING: V3 MIGRATION");

    
    // In a real scenario, you might want to add a confirmation prompt here
    // For automation, we'll proceed directly

    console.log("\n🔄 Executing V3 migration...");

    // Execute v3_migrating transaction
    const tx = await program.methods
      .v3Migrating()
      .accountsPartial({
        config: configPda,
        admin: wallet.publicKey,
        adminTokenAccount: adminTokenAccount,
        poolTokenAccount: config.poolTokenAccount,
        poolAuthority: poolAuthorityPda,
      })
      .rpc();

    console.log("✅ Migration transaction:", tx);
    console.log("🔗 Explorer:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);

    // Wait for confirmation
    await provider.connection.confirmTransaction(tx, 'confirmed');
    console.log("✅ Transaction confirmed");

    // Verify results
    await new Promise(resolve => setTimeout(resolve, 3000));

    const poolBalanceAfter = await getAccount(provider.connection, config.poolTokenAccount);
    const adminBalanceAfter = await getAccount(provider.connection, adminTokenAccount);
    
    const poolAfterInMilk = Number(poolBalanceAfter.amount) / 1_000_000;
    const adminAfterInMilk = Number(adminBalanceAfter.amount) / 1_000_000;
    const tokensReceived = adminAfterInMilk - adminBalanceBefore;

    console.log("\n=== Migration Results ===");
    console.log("Pool Balance After:", poolAfterInMilk.toLocaleString(), "MILK");
    console.log("Admin Balance After:", adminAfterInMilk.toLocaleString(), "MILK");
    console.log("Tokens Migrated:", tokensReceived.toLocaleString(), "MILK");

    if (poolAfterInMilk === 0 && tokensReceived > 0) {
      console.log("✅ V3 Migration completed successfully!");
      console.log("🔒 All pool funds secured for protocol upgrade");
    } else {
      console.log("⚠️  Migration may be incomplete - check transaction logs");
    }

  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    if (error.logs) {
      error.logs.forEach(log => console.error(log));
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("V3 migration failed:", error);
  process.exit(1);
});