import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML } from "confbox";
import { buildCodexProfileToml, parseCodexProfileModel } from "../../../(dashboard)/dashboard/cli-tools/components/codexConfig.js";

export const dynamic = "force-dynamic";

const getCodexDir = () => path.join(os.homedir(), ".codex");

const isSrouterProfile = (content) => parseTOML(content)?.model_provider === "srouter";

async function hasForeignProfile(filePath) {
  try {
    return !isSrouterProfile(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    // An unreadable or malformed existing file must not be overwritten.
    return true;
  }
}

const isValidProfileName = (name) => {
  return typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 64 && name.toLowerCase() !== "config";
};

const isValidModel = (model) => {
  return typeof model === "string" && model.trim().length > 0 && model.length <= 256 && !/[\r\n"]/.test(model);
};

// GET - List all custom profiles from ~/.codex/*.config.toml
export async function GET() {
  try {
    const codexDir = getCodexDir();
    let files = [];
    try {
      files = await fs.readdir(codexDir);
    } catch (err) {
      if (err.code === "ENOENT") return NextResponse.json({ profiles: [] });
      throw err;
    }

    const profileFiles = files.filter(
      (file) => file.endsWith(".config.toml") && file !== "config.toml"
    );

    const profiles = await Promise.all(
      profileFiles.map(async (file) => {
        const name = file.replace(/\.config\.toml$/, "");
        try {
          const content = await fs.readFile(path.join(codexDir, file), "utf-8");
          if (!isSrouterProfile(content)) return null;
          return {
            name,
            model: parseCodexProfileModel(content),
            command: `codex -p ${name}`,
          };
        } catch {
          return null;
        }
      })
    );

    const ownedProfiles = profiles.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ profiles: ownedProfiles });
  } catch (error) {
    console.error("Error reading codex profiles:", error);
    return NextResponse.json({ error: "Failed to read profiles" }, { status: 500 });
  }
}

// POST - Create or update a profile ~/.codex/<name>.config.toml
export async function POST(request) {
  try {
    const { name, model } = await request.json();

    const cleanName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!isValidProfileName(cleanName)) {
      return NextResponse.json(
        { error: "Profile name can only contain alphanumeric characters, dashes, underscores and cannot be 'config'" },
        { status: 400 }
      );
    }

    const cleanModel = typeof model === "string" ? model.trim() : "";
    if (!isValidModel(cleanModel)) {
      return NextResponse.json({ error: "Invalid model name" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    await fs.mkdir(codexDir, { recursive: true });

    const filePath = path.join(codexDir, `${cleanName}.config.toml`);
    if (await hasForeignProfile(filePath)) {
      return NextResponse.json({ error: "Profile belongs to another provider or cannot be read" }, { status: 409 });
    }
    const content = buildCodexProfileToml({ name: cleanName, model: cleanModel });
    await fs.writeFile(filePath, content, "utf-8");

    return NextResponse.json({
      success: true,
      profile: {
        name: cleanName,
        model: cleanModel,
        command: `codex -p ${cleanName}`,
      },
    });
  } catch (error) {
    console.error("Error saving codex profile:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }
}

// DELETE - Remove a profile ~/.codex/<name>.config.toml
export async function DELETE(request) {
  try {
    const { name } = await request.json();
    const cleanName = typeof name === "string" ? name.trim().toLowerCase() : "";

    if (!isValidProfileName(cleanName)) {
      return NextResponse.json({ error: "Invalid profile name" }, { status: 400 });
    }

    const filePath = path.join(getCodexDir(), `${cleanName}.config.toml`);
    if (await hasForeignProfile(filePath)) {
      return NextResponse.json({ error: "Profile belongs to another provider or cannot be read" }, { status: 409 });
    }
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code === "ENOENT") {
        return NextResponse.json({ error: "Profile not found" }, { status: 404 });
      }
      throw err;
    }

    return NextResponse.json({ success: true, message: `Profile ${cleanName} deleted` });
  } catch (error) {
    console.error("Error deleting codex profile:", error);
    return NextResponse.json({ error: "Failed to delete profile" }, { status: 500 });
  }
}
