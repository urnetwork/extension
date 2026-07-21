import { css } from "lit";

export const textStyles = css`
	/* Base styles that apply to all variants */
	:host {
		display: inline-block;
		color: var(--ur-color-white);
	}

	/* Block-level display for headers */
	:host([variant="header"]),
	:host([variant="subheader"]) {
		display: block;
	}

	/* Header variant - maps to h1 */
	:host([variant="header"]) .text {
		font-family: "AbcGravityExtended", system-ui, sans-serif;
		font-size: 2.2rem;
		line-height: 2.4rem;
		font-weight: normal;
		margin: 0;
	}

	/* Subheader variant - maps to h2 */
	:host([variant="subheader"]) .text {
		font-family: "AbcGravityExtraCondensed", system-ui, sans-serif;
		font-size: 2rem; /* 32px */
		/*line-height: 1.3;*/
		font-weight: normal;
		margin: 0;
	}

	/* Body variant (default) - maps to p */
	:host([variant="body"]) .text,
	:host(:not([variant])) .text {
		font-family: var(--ur-font-family-base);
		font-size: 1rem; /* 16px */
		/*line-height: 1.5;*/
		font-weight: normal;
		margin: 0;
	}

	/* Small variant - maps to small */
	:host([variant="small"]) .text {
		font-family: var(--ur-font-family-base);
		font-size: 0.875rem; /* 14px */
		/*line-height: 1.4;*/
		font-weight: normal;
		margin: 0;
	}

	/* Optional: Support for custom color override */
	:host([color]) .text {
		color: inherit;
	}

	/* Optional: Support for bold text */
	:host([bold]) .text {
		font-weight: bold;
	}

	/* Optional: Support for italic text */
	:host([italic]) .text {
		font-style: italic;
	}

	/* Optional: Support for text alignment */
	:host([align="left"]) .text {
		text-align: left;
	}
	:host([align="center"]) .text {
		text-align: center;
	}
	:host([align="right"]) .text {
		text-align: right;
	}
`;
