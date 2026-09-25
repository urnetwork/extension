import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen } from "./Screen";
import {
	UrBackButton,
	UrButton,
	UrIconNetworkInstability,
	UrIconSpinner,
	UrText,
} from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import {
	licenseKey,
	licenseSections,
	licenseSubtitle,
	loadLicenses,
	safeProjectUrl,
	type LicenseInfo,
} from "@/utils/licenses";

// Menu -> Licenses. Same two-panel frame as ConnectScreen: the list on the
// left (data attributions first, then open source software, in the sdk's
// order), the selected entry's license on the right. The first entry — the
// GeoLite2 attribution, whose notice its license requires — is selected on
// open so the required notices are on screen without a click.
export const LicensesScreen: React.FC = () => {
	const navigate = useNavigate();
	const [licenses, setLicenses] = useState<LicenseInfo[] | null>(null);
	const [error, setError] = useState(false);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	// bumped by the retry button; the effect (re)loads on each value
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		loadLicenses().then(
			(list) => {
				if (cancelled) return;
				setLicenses(list);
				setSelectedKey((current) => current ?? (list[0] ? licenseKey(list[0]) : null));
			},
			(err: unknown) => {
				if (cancelled) return;
				console.error("Failed to load licenses:", err);
				setError(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [attempt]);

	const retry = useCallback(() => {
		setError(false);
		setAttempt((n) => n + 1);
	}, []);

	const sections = licenses ? licenseSections(licenses) : null;
	const selected = licenses?.find((license) => licenseKey(license) === selectedKey) ?? null;

	return (
		<Screen>
			{/* ── Left Panel: title + list ── */}
			<div className="w-[280px] shrink-0 h-full flex flex-col" style={{ background: "var(--color-surface-1)" }}>
				<div className="px-2 pt-2">
					<UrBackButton label={getMessage("back")} onClick={() => navigate("/")} />
				</div>
				<div className="px-5 pb-2">
					<h1 className="text-sm font-semibold tracking-wide m-0">{getMessage("licenses")}</h1>
					<p className="text-[11px] opacity-60 leading-snug mt-1 mb-0">{getMessage("licenses_intro")}</p>
				</div>

				{error ? (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<UrIconNetworkInstability className="size-8 opacity-60" />
						<UrText variant="small" className="opacity-60">
							{getMessage("something_went_wrong")}
						</UrText>
						<UrButton variant="secondary" onClick={retry}>
							<UrText>{getMessage("retry")}</UrText>
						</UrButton>
					</div>
				) : !sections ? (
					<div className="flex py-8 justify-center">
						<UrIconSpinner size={1.2} />
					</div>
				) : (
					<div className="flex-1 overflow-y-auto px-4 pb-4" data-testid="licenses-list">
						{sections.data.length > 0 && (
							<LicenseSection label={getMessage("licenses_data_header")}>
								{sections.data.map((license) => (
									<LicenseRow
										key={licenseKey(license)}
										license={license}
										selected={licenseKey(license) === selectedKey}
										onSelect={setSelectedKey}
									/>
								))}
							</LicenseSection>
						)}
						{sections.software.length > 0 && (
							<LicenseSection label={getMessage("licenses_software_header")}>
								{sections.software.map((license) => (
									<LicenseRow
										key={licenseKey(license)}
										license={license}
										selected={licenseKey(license) === selectedKey}
										onSelect={setSelectedKey}
									/>
								))}
							</LicenseSection>
						)}
					</div>
				)}
			</div>

			{/* ── Right Panel: the selected entry ── */}
			<div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: "var(--color-surface-0)" }}>
				{selected && <LicenseDetail key={selectedKey} license={selected} />}
			</div>
		</Screen>
	);
};

// ── Sub-components ───────────────────────────────────────────────────────────

const LicenseSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
	<div className="mb-2">
		<div className="sticky top-0 z-10 py-2 px-1" style={{ background: "var(--color-surface-1)" }}>
			<span className="text-[11px] font-semibold uppercase tracking-wider opacity-40">{label}</span>
		</div>
		<div className="rounded-xl overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
			{children}
		</div>
	</div>
);

const LicenseRow: React.FC<{
	license: LicenseInfo;
	selected: boolean;
	onSelect: (key: string) => void;
}> = ({ license, selected, onSelect }) => {
	const subtitle = licenseSubtitle(license);
	return (
		<button
			type="button"
			onClick={() => onSelect(licenseKey(license))}
			aria-current={selected ? "true" : undefined}
			className="w-full text-left flex flex-col gap-0.5 px-3 py-2 cursor-pointer border-0 transition-colors hover:bg-[var(--color-surface-3)]"
			style={{
				background: selected ? "var(--color-surface-3)" : "transparent",
				color: "inherit",
				font: "inherit",
			}}
		>
			<span className="text-xs font-medium break-words">{license.name}</span>
			{subtitle && <span className="text-[10px] opacity-50 leading-tight break-words">{subtitle}</span>}
			{license.notice && (
				<span className="text-[10px] leading-tight" style={{ color: "var(--ur-color-yellow-light)" }}>
					{license.notice}
				</span>
			)}
		</button>
	);
};

const LicenseDetail: React.FC<{ license: LicenseInfo }> = ({ license }) => {
	const subtitle = licenseSubtitle(license);
	const projectUrl = safeProjectUrl(license.url);
	return (
		<div className="flex-1 min-h-0 flex flex-col gap-2 px-4 pt-4 pb-4" data-testid="license-detail">
			<div className="flex flex-col gap-0.5">
				<h2 className="text-sm font-semibold m-0 break-words">{license.name}</h2>
				{subtitle && <span className="text-[11px] opacity-60">{subtitle}</span>}
			</div>

			{license.notice && (
				// required attribution: shown verbatim, emphasized
				<div
					className="rounded-xl px-3 py-2 text-xs font-medium whitespace-pre-line select-text"
					style={{
						background: "var(--color-surface-2)",
						borderLeft: "3px solid var(--ur-color-yellow-light)",
					}}
				>
					{license.notice}
				</div>
			)}

			{license.copyright && (
				<p className="text-[11px] opacity-70 whitespace-pre-line m-0 select-text">{license.copyright}</p>
			)}

			{projectUrl && (
				<a
					href={projectUrl}
					target="_blank"
					rel="noopener noreferrer"
					referrerPolicy="no-referrer"
					className="text-xs self-start"
				>
					{getMessage("licenses_project_page")}
				</a>
			)}

			{license.text && (
				<pre
					className="flex-1 min-h-0 overflow-auto m-0 rounded-xl p-3 text-[10px] leading-snug font-mono whitespace-pre-wrap break-words select-text"
					style={{ background: "var(--color-surface-1)" }}
					tabIndex={0}
				>
					{license.text}
				</pre>
			)}
		</div>
	);
};

export default LicensesScreen;
