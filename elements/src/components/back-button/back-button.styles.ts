import { css } from "lit";

export const backBtnStyles = css`
	:host {
		font-family: "PpNeueBitBold", system-ui, sans-serif;
		font-size: 1.4rem;
	}

	button {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 8px 12px;
		cursor: pointer;
		color: var(--ur-color-gray);
	}

	button:hover {
		color: var(--ur-color-green);
	}
`;
