import * as React from "react";
import { createComponent } from "@lit/react";
import { SelectedLocation as UrSelectedLocationElement } from "../../components/selected-location";

export const SelectedLocation = createComponent({
	tagName: "ur-selected-location",
	elementClass: UrSelectedLocationElement,
	react: React,
	events: {
		onClick: "click",
	},
});

export interface SelectedLocationProps {
	locationKey: string;
	name?: string;
	providerCount?: number;
	unstable?: boolean;
	strongPrivacy?: boolean;
	onClick?: () => void;
	className?: string;
	style?: React.CSSProperties;
}

export const UrSelectedLocation = React.forwardRef<
	UrSelectedLocationElement,
	SelectedLocationProps
>((props, ref) => {
	return <SelectedLocation ref={ref} {...props} />;
});

UrSelectedLocation.displayName = "UrSelectedLocation";

export { UrSelectedLocationElement };
export default UrSelectedLocation;
