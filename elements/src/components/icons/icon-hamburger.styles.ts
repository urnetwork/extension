import { css } from "lit";

export const iconHamburgerStyles = css`
	:host {
		width: 1.2em;
		height: 1.2em;
	}

	svg {
		color: var(--ur-color-gray-dark);
	}

	svg:hover {
		color: var(--ur-color-green);
	}
`;
