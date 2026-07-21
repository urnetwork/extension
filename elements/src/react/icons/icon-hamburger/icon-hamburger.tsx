import * as React from "react";
import { createComponent } from "@lit/react";
import { IconHamburger as UrIconHamburgerElement } from "../../../components/icons/icon-hamburger";

export const IconHamburger = createComponent({
	tagName: "ur-icon-hamburger",
	elementClass: UrIconHamburgerElement,
	react: React,
});

export interface IconHamburgerProps {
	className?: string;
	style?: React.CSSProperties;
}

export const UrIconHamburger = React.forwardRef<
	UrIconHamburgerElement,
	IconHamburgerProps
>((props, ref) => {
	return <IconHamburger ref={ref} {...props} />;
});

UrIconHamburger.displayName = "UrIconHamburger";

export { UrIconHamburgerElement };
export default UrIconHamburger;
