/**
 * User Action Cards (DESIGN.md §14.2): one catalog of the things only the person can do, each with
 * steps, why, how often, and when the app may be closed. Engines throw `UserActionError`; the MCP
 * layer puts the card into the tool result; agents relay `say` as is.
 */
import type { UserAction } from './types.js';
export declare class UserActionError extends Error {
    readonly userAction: UserAction;
    constructor(message: string, userAction: UserAction);
}
/** Plain Thai text of a card, ready for the agent to show unchanged. */
export declare function userActionText(a: UserAction): string;
/** Card + its text, the shape tools return under `userAction`. */
export declare function card(a: UserAction): UserAction & {
    say: string;
};
type Opts = Record<string, string | number | undefined>;
export declare const ACTIONS: {
    aeNotFound: () => UserAction;
    aeFirstRun: (o?: Opts) => UserAction;
    aeAllowScripts: () => UserAction;
    aeCloseMac: () => UserAction;
    macAutomation: () => UserAction;
    ffmpegMissing: (o?: Opts) => UserAction;
    premiereNotFound: () => UserAction;
    bridgeNotInstalled: () => UserAction;
    bridgeUpdate: (o?: Opts) => UserAction;
    bridgeOutdated: (o?: Opts) => UserAction;
    bridgeNotStarted: () => UserAction;
    premiereDialog: (o?: Opts) => UserAction;
    premiereNeedsProject: (o?: Opts) => UserAction;
    premiereStartTimeout: (o?: Opts) => UserAction;
    diskLow: (o?: Opts) => UserAction;
};
export {};
