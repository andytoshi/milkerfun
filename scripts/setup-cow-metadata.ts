import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createMetadataAccountV3 } from "@metaplex-foundation/mpl-token-metadata";
import { 
  publicKey, 
  createSignerFromKeypair, 
  signerIdentity
} from "@metaplex-foundation/umi";
import * as fs from "fs";
import * as os from "os";

/**
 * Setup script to add metadata to COW token using admin authority
 * Run this AFTER deploy-setup but BEFORE transfer-cow-authority
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

  console.log("=== COW Token Metadata Setup ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  try {
    // Get config PDA
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    const cowMint = config.cowMint;

    console.log("COW Mint:", cowMint.toString());

    // Verify admin is current mint authority
    const mintInfo = await connection.getAccountInfo(cowMint);
    if (!mintInfo) {
      throw new Error("COW mint account not found");
    }

    console.log("✅ COW mint found, admin should be current authority");

    // Initialize UMI
    const umi = createUmi(connection.rpcEndpoint);
    
    // Convert Anchor keypair to UMI keypair
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(walletKeypair.secretKey);
    const signer = createSignerFromKeypair(umi, umiKeypair);
    umi.use(signerIdentity(signer));

    console.log("✅ UMI initialized with admin signer");

    console.log("\n=== Creating Metadata ===");
    console.log("Name: MilkerFun Cow");
    console.log("Symbol: COW");
    console.log("URI: https://arweave.net/placeholder-cow-metadata.json");
    console.log("Creator:", wallet.publicKey.toString());

    // Create metadata using UMI with admin as mint authority
    const result = await createMetadataAccountV3(umi, {
      mint: publicKey(cowMint.toString()),
      mintAuthority: signer, // Admin is current mint authority
      payer: signer,
      updateAuthority: signer,
      data: {
        name: "MilkerFun Cow",
        symbol: "COW",
        uri: "https://arweave.net/placeholder-cow-metadata.json",
        sellerFeeBasisPoints: 0, // 0% royalty
        creators: [
          {
            address: publicKey(wallet.publicKey.toString()),
            verified: true,
            share: 100,
          },
        ],
        collection: null,
        uses: null,
      },
      isMutable: true,
      collectionDetails: null,
    }).sendAndConfirm(umi);

    console.log("✅ Metadata created successfully!");
    console.log("Transaction signature:", result.signature);
    console.log("🔗 Explorer:", `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`);

    console.log("\n=== Metadata Setup Complete ===");
    console.log("COW token now has proper metadata for:");
    console.log("✅ DEX listings (Jupiter, Raydium, etc.)");
    console.log("✅ Wallet display (Phantom, Solflare, etc.)");
    console.log("✅ Block explorers (Solscan, SolanaFM, etc.)");

    console.log("\n⚠️  IMPORTANT NEXT STEP:");
    console.log("Run 'yarn transfer-cow-authority' to transfer mint authority to PDA");
    console.log("This will enable export/import functionality while preserving metadata");

  } catch (error) {
    console.error("❌ Metadata setup failed:", error.message);
    if (error.logs) {
      error.logs.forEach(log => console.error(log));
    }
    
    console.log("\n💡 Troubleshooting:");
    console.log("1. Make sure you ran 'yarn deploy-setup' first");
    console.log("2. Ensure admin wallet has SOL for transaction fees");
    console.log("3. Verify COW mint authority is still admin (not transferred yet)");
    
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Metadata setup failed:", error);
  process.exit(1);
});