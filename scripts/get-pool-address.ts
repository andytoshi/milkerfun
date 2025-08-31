import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Script to get the pool token account address
 * Frontend needs this to call buy_cows
 */
async function main() {
  // Set up provider manually to avoid env variable issues
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

  // Get config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  // Get pool authority PDA
  const [poolAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), configPda.toBuffer()],
    program.programId
  );

  console.log("=== Pool Information for Frontend ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Config PDA:", configPda.toString());
  console.log("Pool Authority PDA:", poolAuthorityPda.toString());

  try {
    const config = await program.account.config.fetch(configPda);
    console.log("MILK Mint:", config.milkMint.toString());

    // Find pool token account
    const poolTokenAccounts = await provider.connection.getTokenAccountsByOwner(
      poolAuthorityPda,
      { mint: config.milkMint }
    );

    if (poolTokenAccounts.value.length > 0) {
      const poolTokenAccount = poolTokenAccounts.value[0].pubkey;
      console.log("Pool Token Account:", poolTokenAccount.toString());
      
      console.log("\n=== Frontend Integration ===");
      console.log("Save these addresses for your frontend:");
      console.log(`PROGRAM_ID = "${program.programId.toString()}"`);
      console.log(`MILK_MINT = "${config.milkMint.toString()}"`);
      console.log(`CONFIG_PDA = "${configPda.toString()}"`);
      console.log(`POOL_AUTHORITY_PDA = "${poolAuthorityPda.toString()}"`);
      console.log(`POOL_TOKEN_ACCOUNT = "${poolTokenAccount.toString()}"`);
    } else {
      console.log("❌ Pool token account not found! Run deploy-setup first.");
    }
  } catch (error) {
    console.log("❌ Config not found! Run deploy-setup first.");
  }
}

main().catch((error) => {
  console.error("Failed to get pool address:", error);
  process.exit(1);
});