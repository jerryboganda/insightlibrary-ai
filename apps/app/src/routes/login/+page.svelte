<script lang="ts">
	import { goto } from '$app/navigation';
	import { BookOpen, Loader2 } from '@lucide/svelte';
	import { Button, Input, Card } from '$lib/components/ui';
	import { authClient } from '$lib/auth-client';
	import { api } from '$lib/api';
	import { ApiError } from '@insightlibrary/api-client';

	let mode = $state<'signin' | 'signup'>('signin');
	let name = $state('');
	let email = $state('admin@insightlibrary.ai');
	let password = $state('');
	let loading = $state(false);
	let errorMsg = $state('');

	async function submit() {
		loading = true;
		errorMsg = '';
		try {
			// Probe the server first. Dev-bypass mode reports an authenticated seeded
			// session (or 501s on auth-only endpoints) — only then is "just enter"
			// safe. Any other probe failure is a real error and must be shown, never
			// silently redirected into a broken anonymous session.
			try {
				const session = await api.session();
				if (session.authenticated && session.user !== null) {
					// Dev bypass, or an already-active session — nothing to sign in.
					goto('/');
					return;
				}
			} catch (e) {
				if (e instanceof ApiError && e.status === 501) {
					// Explicit dev-bypass signal.
					goto('/');
					return;
				}
				errorMsg = 'Could not reach the server. Check your connection and try again.';
				return;
			}

			const res =
				mode === 'signup'
					? await authClient.signUp.email({ email, password, name: name || email })
					: await authClient.signIn.email({ email, password });

			if (res.error) {
				// Dev-bypass servers 501 the auth endpoints; treat that as "just enter".
				if (res.error.status === 501) {
					goto('/');
					return;
				}
				errorMsg =
					res.error.message ??
					(mode === 'signup' ? 'Could not create the account.' : 'Invalid email or password.');
				return;
			}

			// Success only. On desktop the auth client has already stored the bearer
			// session token in the OS keyring (see $lib/auth-client fetchOptions).
			goto('/');
		} catch {
			errorMsg = 'Network error — could not reach the authentication server. Please try again.';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 flex flex-col items-center gap-3 text-center">
			<div class="rounded-xl bg-indigo-500/10 p-3 text-indigo-400"><BookOpen class="h-7 w-7" /></div>
			<h1 class="text-2xl font-bold tracking-tight text-zinc-100">
				InsightLibrary <span class="text-indigo-400">AI</span>
			</h1>
			<p class="text-sm text-zinc-500">
				{mode === 'signup' ? 'Create your knowledge workspace' : 'Sign in to your knowledge workspace'}
			</p>
		</div>

		<Card class="p-6">
			<form onsubmit={(e) => { e.preventDefault(); submit(); }} class="space-y-4">
				{#if mode === 'signup'}
					<div>
						<label for="name" class="mb-1.5 block text-sm font-medium text-zinc-300">Name</label>
						<Input id="name" bind:value={name} placeholder="Dr. Jane Doe" />
					</div>
				{/if}
				<div>
					<label for="email" class="mb-1.5 block text-sm font-medium text-zinc-300">Email</label>
					<Input id="email" type="email" bind:value={email} placeholder="you@org.com" />
				</div>
				<div>
					<label for="pw" class="mb-1.5 block text-sm font-medium text-zinc-300">Password</label>
					<Input id="pw" type="password" bind:value={password} placeholder="••••••••" />
				</div>
				{#if errorMsg}
					<p class="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{errorMsg}</p>
				{/if}
				<Button type="submit" class="w-full" disabled={loading}>
					{#if loading}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					{mode === 'signup' ? 'Create account' : 'Sign in'}
				</Button>
			</form>
			<button
				type="button"
				onclick={() => { mode = mode === 'signin' ? 'signup' : 'signin'; errorMsg = ''; }}
				class="mt-4 w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
			>
				{mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}
			</button>
		</Card>
	</div>
</div>
