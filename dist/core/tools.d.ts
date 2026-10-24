import type { Encoders, Environment, ToolPaths } from './types.js';
/** Find ffmpeg/ffprobe: env EDITMCP_FFMPEG, PATH, then the winget (Windows) or Homebrew (macOS) folders. */
export declare function findFfmpeg(): {
    ffmpeg: string;
    ffprobe: string;
} | undefined;
/**
 * Newest After Effects (or EDITMCP_AE_DIR = its version folder). Windows: AfterFX.com/.exe and aerender.exe
 * under "Support Files". macOS: `afterfx` is the .app bundle (scripts run through AppleScript) and aerender
 * sits next to it.
 */
export declare function findAfterEffects(): Pick<ToolPaths, 'afterfx' | 'aerender' | 'aeVersionDir'>;
/** Premiere / Media Encoder: the .exe on Windows, the .app bundle on macOS. */
export declare function findPremiere(): Pick<ToolPaths, 'premiereExe' | 'mediaEncoderExe'>;
/**
 * ArtCraft headless CLIs (optional): EDITMCP_FILMCRAFT_DIR / EDITMCP_EFFECTCRAFT_DIR (e.g. a portable
 * zip), else the MSI install folders under Program Files.
 */
export declare function findArtCraft(): Pick<ToolPaths, 'filmcraftCli' | 'effectcraftCli'>;
export declare function discoverTools(): ToolPaths;
export declare function probeEncoders(ffmpeg: string): Promise<Encoders & {
    version?: string;
}>;
export declare function getEnvironment(): Promise<Environment>;
