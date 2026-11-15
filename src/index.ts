import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinueInput } from "./continue.ts";
import { registerRetryControl } from "./retry-control.ts";

export default function interruptControl(pi: ExtensionAPI) {
	registerContinueInput(pi);
	registerRetryControl(pi);
}
