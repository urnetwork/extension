import { css } from "lit";

export const menuButtonStyles = css`
	:host {
		display: inline-block;
	}

	.button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border: none;
		background: transparent;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}

	.button:hover {
		background-color: var(--ur-color-hover, rgba(0, 0, 0, 0.05));
	}

	.button:focus-visible {
		outline: 2px solid var(--ur-color-focus, #000000);
		outline-offset: 2px;
	}
`;
