import * as React from "react";
import { createComponent } from "@lit/react";
import { IconSpinner as UrIconSpinnerElement } from "../../../components/icons/icon-spinner";

export const IconSpinner = createComponent({
	tagName: "ur-icon-spinner",
	elementClass: UrIconSpinnerElement,
	react: React,
});

export interface IconSpinnerProps {
	iconTitle?: string;
	/** Size in rem units. Defaults to 1.6 */
	size?: number;
	/** Color override (e.g. "white", "#ff0000"). If undefined, inherits from parent or uses default gray. */
	color?: string;
	className?: string;
	style?: React.CSSProperties;
}

export const UrIconSpinner = React.forwardRef<
	UrIconSpinnerElement,
	IconSpinnerProps
>((props, ref) => {
	return <IconSpinner ref={ref} {...props} />;
});

UrIconSpinner.displayName = "UrIconSpinner";

export { UrIconSpinnerElement };
export default UrIconSpinner;
