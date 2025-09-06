import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as METADATA_PROGRAM_ID,
  DataV2,
} from "@metaplex-foundation/mpl-token-metadata";
import * as fs from "fs";
import * as os from "os";

/**
 * Setup script to add metadata to COW token
 * Run this after deploy-setup to add proper token metadata for DEX listings
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

    // Derive metadata PDA
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        cowMint.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );

    console.log("Metadata PDA:", metadataPda.toString());

    // Check if metadata already exists
    try {
      const existingMetadata = await provider.connection.getAccountInfo(metadataPda);
      if (existingMetadata) {
        console.log("⚠️  Metadata already exists for COW token");
        console.log("If you want to update it, you'll need to use updateMetadataAccountV2");
        return;
      }
    } catch (error) {
      // Metadata doesn't exist, continue with creation
    }

    // Define metadata with placeholder data
    const tokenMetadata: DataV2 = {
      name: "MilkerFun Cow",
      symbol: "COW",
      uri: "https://placeholder.com/cow-metadata.json", // You can replace this
      sellerFeeBasisPoints: 0, // No royalties for fungible tokens
      creators: [
        {
          address: wallet.publicKey,
          verified: true,
          share: 100,
        },
      ],
      collection: null,
      uses: null,
    };

    console.log("\n=== Creating Metadata ===");
    console.log("Name:", tokenMetadata.name);
    console.log("Symbol:", tokenMetadata.symbol);
    console.log("URI:", tokenMetadata.uri);
    console.log("Creator:", wallet.publicKey.toString());

    // Get COW mint authority PDA
    const [cowMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cow_mint_authority"), configPda.toBuffer()],
      program.programId
    );

    // Create metadata instruction
    const createMetadataInstruction = createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPda,
        mint: cowMint,
        mintAuthority: cowMintAuthorityPda, // Program controls the mint
        payer: wallet.publicKey,
        updateAuthority: wallet.publicKey, // Admin can update metadata
      },
      {
        createMetadataAccountArgsV3: {
          data: tokenMetadata,
          isMutable: true, // Allow future updates
          collectionDetails: null,
        },
      }
    );

    // Send transaction
    const transaction = new anchor.web3.Transaction().add(createMetadataInstruction);
    
    console.log("🔄 Creating metadata account...");
    const signature = await provider.sendAndConfirm(transaction);
    
    console.log("✅ Metadata created successfully!");
    console.log("Transaction signature:", signature);
    console.log("🔗 Explorer:", `https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    // Verify metadata creation
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
      const metadataAccount = await provider.connection.getAccountInfo(metadataPda);
      if (metadataAccount) {
        console.log("✅ Metadata account verified");
        console.log("Account size:", metadataAccount.data.length, "bytes");
      }
    } catch (error) {
      console.log("⚠️  Could not verify metadata account, but transaction succeeded");
    }

    console.log("\n=== Metadata Setup Complete ===");
    console.log("COW token now has proper metadata for:");
    console.log("✅ DEX listings (Jupiter, Raydium, etc.)");
    console.log("✅ Wallet display (Phantom, Solflare, etc.)");
    console.log("✅ Block explorers (Solscan, SolanaFM, etc.)");

    console.log("\n💡 Next Steps:");
    console.log("1. Create a JSON metadata file and host it publicly");
    console.log("2. Update the URI to point to your hosted metadata");
    console.log("3. Add a proper COW token image/logo");
    console.log("4. Update social links and description");

    console.log("\n📝 Example metadata JSON structure:");
    console.log(JSON.stringify({
      name: "MilkerFun Cow",
      symbol: "COW",
      description: "Tradeable cows from MilkerFun yield farming protocol. Import to your farm to earn MILK rewards.",
      image: "https://your-domain.com/cow-logo.png",
      external_url: "https://milker.fun",
      attributes: [
        { trait_type: "Type", value: "Yield Farming Token" },
        { trait_type: "Protocol", value: "MilkerFun" },
        { trait_type: "Utility", value: "Stakeable for MILK rewards" }
      ],
      properties: {
        category: "fungible"
      }
    }, null, 2));

  } catch (error) {
    console.error("❌ Metadata setup failed:", error.message);
    if (error.logs) {
      error.logs.forEach(log => console.error(log));
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Metadata setup failed:", error);
  process.exit(1);
});