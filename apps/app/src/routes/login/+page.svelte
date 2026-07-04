<script lang="ts">
	import { goto } from '$app/navigation';
	import { BookOpen, Loader2 } from '@lucide/svelte';
	import { Button, Input, Card } from '$lib/components/ui';

	let email = $state('admin@insightlibrary.ai');
	let password = $state('');
	let loading = $state(false);

	// Dev: auth is bypassed server-side (seeded admin), so sign-in just enters.
	// With DATABASE_URL, wire this to better-auth's email/password endpoint.
	async function signIn() {
		loading = true;
		await new Promise((r) => setTimeout(r, 400));
		loading = false;
		goto('/');
	}
</script>

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 flex flex-col items-center gap-3 text-center">
			<div class="rounded-xl bg-indigo-500/10 p-3 text-indigo-400"><BookOpen class="h-7 w-7" /></div>
			<h1 class="text-2xl font-bold tracking-tight text-zinc-100">InsightLibrary <span class="text-indigo-400">AI</span></h1>
			<p class="text-sm text-zinc-500">Sign in to your knowledge workspace</p>
		</div>

		<Card class="p-6">
			<form onsubmit={(e) => { e.preventDefault(); signIn(); }} class="space-y-4">
				<div>
					<label for="email" class="mb-1.5 block text-sm font-medium text-zinc-300">Email</label>
					<Input id="email" type="email" bind:value={email} placeholder="you@org.com" />
				</div>
				<div>
					<label for="pw" class="mb-1.5 block text-sm font-medium text-zinc-300">Password</label>
					<Input id="pw" type="password" bind:value={password} placeholder="••••••••" />
				</div>
				<Button type="submit" class="w-full" disabled={loading}>
					{#if loading}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Sign in
				</Button>
			</form>
			<p class="mt-4 text-center text-xs text-zinc-600">Dev mode: authentication is bypassed (seeded admin).</p>
		</Card>
	</div>
</div>
