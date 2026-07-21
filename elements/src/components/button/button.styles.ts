import { css } from "lit";

export const btnStyles = css`
	button {
		font-family: "PpNeueBitBold", system-ui, sans-serif;
		font-size: 1.4rem;
		padding: 0.8rem 1.6rem;
		border-radius: 0.8rem;
		border: none;
		cursor: pointer;
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			background 0.1s ease,
			border-color 0.1s ease;
	}
	:host([variant="primary"]) button {
		background: var(--ur-color-blue-electric);
		color: var(--ur-color-white);
		border: 1px solid var(--ur-color-blue-electric);
	}
	:host([variant="primary"]) button:disabled {
		background: color-mix(
			in srgb,
			var(--ur-color-blue-electric) 70%,
			white 30%
		);
		color: var(--ur-color-white);
		border: 1px solid
			color-mix(in srgb, var(--ur-color-blue-electric) 70%, white 30%);
		cursor: not-allowed;
	}
	:host([variant="primary"]) button:hover:not(:disabled) {
		background: color-mix(
			in srgb,
			var(--ur-color-blue-electric) 85%,
			white 15%
		);
		border: 1px solid
			color-mix(in srgb, var(--ur-color-blue-electric) 85%, white 15%);
	}
	:host([variant="secondary"]) button {
		background: transparent;
		color: var(--ur-color-gray-dark);
		border: 1px solid var(--ur-color-gray-dark);
	}
	:host([variant="secondary"]) button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 2%);
		border-color: color-mix(in srgb, var(--ur-color-gray-dark) 80%, black 20%);
		color: color-mix(in srgb, var(--ur-color-gray-dark) 80%, black 20%);
	}
	:host([fullwidth]) {
		display: block;
		width: 100%;
	}
	:host([fullwidth]) button {
		width: 100%;
		display: block;
	}
	.button-content {
		/* Hide when loading, but preserve space */
		visibility: visible;
	}
	.button-spinner {
		display: none;
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
	}

	:host([loading]) .button-content {
		visibility: hidden;
	}
	:host([loading]) .button-spinner {
		display: block;
	}
`;
