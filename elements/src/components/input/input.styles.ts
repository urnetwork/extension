import { css } from "lit";

export const inputStyles = css`
	:host {
		display: block;
		font-family: var(--font-family-base, system-ui, sans-serif);
		width: 100%;
	}

	.input-wrapper {
		display: flex;
		flex-direction: column;
		gap: var(--ur-space-sm, 0.5rem);
		align-items: flex-start;
		width: 100%;
	}

	.input-container {
		position: relative;
		display: flex;
		align-items: center;
		width: 100%;
	}

	.input-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--ur-color-gray-dark);
	}

	.input-label.error {
		color: var(--ur-color-coral, #ff6c58);
	}

	.required {
		color: var(--ur-color-coral);
		margin-left: 0.25rem;
	}

	.input-field {
		width: 100%;
		padding: 0.75rem 1rem;
		font-size: 1rem;
		color: var(--ur-color-black, #000);
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 5%);
		border: 1px solid var(--ur-color-border);
		border-radius: 0.5rem;
		transition:
			border-color 0.1s ease,
			box-shadow 0.1s ease;
		outline: none;
		box-sizing: border-box;
		color: var(--ur-color-white);
	}

	/* Hover state */
	.input-field:hover:not([disabled]):not([readonly]) {
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 7%);
		border-color: color-mix(in srgb, var(--ur-color-border, #101010), #fff 2%);
	}

	.input-field:focus {
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 10%);

		border: 1px solid
			color-mix(in srgb, var(--ur-color-black, #101010), #fff 15%);
	}

	.input-field[disabled] {
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 2%);
		color: color-mix(in srgb, var(--ur-color-gray, #b7b7b7), transparent 60%);
		border-color: color-mix(in srgb, var(--ur-color-black, #101010), #fff 15%);
		cursor: not-allowed;
		opacity: 0.6;
	}

	.input-field[readonly] {
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 2%);
		color: var(--color-white, #f8f8f8);
		border-color: color-mix(in srgb, var(--ur-color-black, #101010), #fff 15%);
		cursor: default;
		opacity: 0.6;
	}

	.input-field.error {
		border-color: var(--ur-color-coral, #ff6c58);
	}

	.input-field.error:focus {
		border-color: color-mix(in srgb, var(--ur-color-coral, #ff6c58), #fff 15%);
	}

	.hint {
		font-size: 0.875rem;
		color: var(--ur-color-gray-dark);
		text-align: left;
	}

	.hint.error {
		color: var(--ur-color-coral, #ff6c58);
	}

	:host([loading]) .input-field {
		padding-right: 2.75rem;
	}

	/* Error icon state */
	:host([invalid]) .input-field {
		padding-right: 2.75rem;
	}

	.input-spinner,
	.input-error-icon {
		position: absolute;
		right: 0.75rem;
		pointer-events: none;
	}
`;
