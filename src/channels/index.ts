import { telegram } from "./telegram.js";
import { whatsapp } from "./whatsapp.js";
import type { ChannelAdapter, ChannelName } from "./types.js";

export const channels: Record<ChannelName, ChannelAdapter> = { telegram, whatsapp };
