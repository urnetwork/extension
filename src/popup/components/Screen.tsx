import React from "react";

export const Screen: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	return (
		<div className="h-full flex flex-row w-full overflow-hidden">
			{children}
		</div>
	);
};
