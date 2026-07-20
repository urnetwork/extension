import { css } from "lit";

export const menuStyles = css`
	:host {
		display: inline-block;
		position: relative;
	}

	.menu-container {
		position: relative;
	}

	.menu-button {
		display: inline-block;
	}

	.menu-items {
		display: none;
		position: fixed;
		z-index: 1000;
		min-width: 200px;
		background: color-mix(in srgb, var(--ur-color-black, #101010), #fff 7%);
		border: 1px solid var(--ur-color-border, #000000);
		box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.1);
		color: var(--ur-color-white, #ffffff);
		border-radius: 0.5rem;
		padding: 0.5rem 0;
		overflow: hidden;
	}

	:host([open]) .menu-items {
		display: flex;
		flex-flow: column;
	}
`;
