import * as React from "react";
import { createComponent } from "@lit/react";
import {
	Text as UrTextElement,
	TEXT_VARIANTS,
	type TextVariant,
} from "../../components/text/text.js";

// Create the React component wrapper
export const Text = createComponent({
	tagName: "ur-text",
	elementClass: UrTextElement,
	react: React,
});

export interface TextProps {
	variant?: TextVariant;
	color?: string;
	bold?: boolean;
	italic?: boolean;
	align?: "left" | "center" | "right";
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

// Typed wrapper component
export const UrText = React.forwardRef<UrTextElement, TextProps>(
	(props, ref) => {
		return <Text ref={ref} {...props} />;
	},
);

UrText.displayName = "UrText";

export { UrTextElement, TEXT_VARIANTS, type TextVariant };
export default UrText;
