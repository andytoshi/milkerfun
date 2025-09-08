import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Inspect COW mint to see current authority
 */
async function main() {
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );
  
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.milkerfun as Program<Milkerfun>;

  console.log("=== COW Mint Inspection ===");
  console.log("Admin:", wallet.publicKey.toString());

  try {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    const cowMint = config.cowMint;

    console.log("COW Mint:", cowMint.toString());

    // Get mint info
    const mintInfo = await getMint(connection, cowMint);
    
    console.log("\n=== Mint Information ===");
    console.log("Supply:", mintInfo.supply.toString());
    console.log("Decimals:", mintInfo.decimals);
    console.log("Mint Authority:", mintInfo.mintAuthority?.toString() || "null (frozen)");
    console.log("Freeze Authority:", mintInfo.freezeAuthority?.toString() || "null");
    console.log("Is Initialized:", mintInfo.isInitialized);

    console.log("\n=== Expected Authorities ===");
    console.log("Admin (current):", wallet.publicKey.toString());
    
    const [cowMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cow_mint_authority"), configPda.toBuffer()],
      program.programId
    );
    console.log("PDA (target):", cowMintAuthorityPda.toString());

    // Check if admin is current authority
    const isAdminAuthority = mintInfo.mintAuthority?.equals(wallet.publicKey);
    const isPdaAuthority = mintInfo.mintAuthority?.equals(cowMintAuthorityPda);
    
    console.log("\n=== Authority Status ===");
    console.log("Admin is mint authority:", isAdminAuthority);
    console.log("PDA is mint authority:", isPdaAuthority);
    console.log("Mint authority is null:", mintInfo.mintAuthority === null);

    if (mintInfo.mintAuthority === null) {
      console.log("\n❌ PROBLEM: Mint authority is null (frozen)");
      console.log("This means the mint was frozen during metadata creation");
      console.log("Export/import functionality will NOT work");
      console.log("\n💡 SOLUTION: Redeploy with a different approach");
    } else if (isAdminAuthority) {
      console.log("\n✅ GOOD: Admin is current authority");
      console.log("You can run 'yarn transfer-cow-authority' to transfer to PDA");
    } else if (isPdaAuthority) {
      console.log("\n✅ PERFECT: PDA is already the authority");
      console.log("Export/import functionality should work");
    } else {
      console.log("\n⚠️  UNKNOWN: Authority is someone else");
      console.log("Current authority:", mintInfo.mintAuthority?.toString());
    }

  } catch (error) {
    console.error("❌ Inspection failed:", error.message);
    process.exit(1);
  }
}

main().catch(console.error);