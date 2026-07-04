/** Join class names, dropping falsy values. Lightweight cn() for Tailwind. */
export function cn(...classes: Array<string | false | null | undefined>): string {
	return classes.filter(Boolean).join(' ');
}

/** Map a 0-100 health/score to a semantic color class. */
export function healthColor(value: number): string {
	if (value >= 85) return 'text-emerald-400';
	if (value >= 70) return 'text-amber-400';
	return 'text-rose-400';
}

export function healthBg(value: number): string {
	if (value >= 85) return 'bg-emerald-500';
	if (value >= 70) return 'bg-amber-500';
	return 'bg-rose-500';
}
