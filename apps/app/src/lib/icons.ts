import {
	Activity,
	FlaskConical,
	Pill,
	Stethoscope,
	Zap,
	Dna,
	Users,
	FileText,
	type Icon as LucideIcon
} from '@lucide/svelte';

/** Resolve a lucide icon name (stored on SSOT sections) to its component. */
const MAP: Record<string, typeof LucideIcon> = {
	FlaskConical,
	Activity,
	Pill,
	Stethoscope,
	Zap,
	Dna,
	Users
};

export function iconByName(name: string): typeof LucideIcon {
	return MAP[name] ?? FileText;
}
