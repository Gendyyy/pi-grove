export type PiFffPackageIdentity = "@ff-labs/pi-fff";
export type PiFffCapabilityProfile = "scoped";

/** One personal integration target, not a cross-version compatibility matrix. */
export const PI_FFF_PROFILE = Object.freeze({
	identity: "@ff-labs/pi-fff" as const,
	profile: "scoped" as const,
	version: "0.11.0",
	segments: Object.freeze(["@ff-labs", "pi-fff"]),
});
export type PiFffPackageProfile = typeof PI_FFF_PROFILE;

export function matchPiFffSource(source: string | undefined): { packageProfile: PiFffPackageProfile; version?: string } | undefined {
	const prefix = `npm:${PI_FFF_PROFILE.identity}`;
	if (source === prefix) return { packageProfile: PI_FFF_PROFILE };
	if (source?.startsWith(`${prefix}@`) && source.length > prefix.length + 1) {
		return { packageProfile: PI_FFF_PROFILE, version: source.slice(prefix.length + 1) };
	}
	return undefined;
}
