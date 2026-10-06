import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { hasProviderBanRisk, PROVIDER_BAN_RISK_NOTICE } from "./providerBanRisk";

export default function ProviderBanRiskBadge({ providerId }) {
  if (!hasProviderBanRisk(providerId)) return null;
  return (
    <span className="inline-flex shrink-0" title={PROVIDER_BAN_RISK_NOTICE} aria-label={`Ban risk: ${PROVIDER_BAN_RISK_NOTICE}`}>
      <Badge variant="warning" size="sm">
        <span aria-hidden="true" className="relative size-2.5 shrink-0">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="absolute -left-[3px] -top-[3px] size-4">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
          </svg>
        </span>
        Ban risk
      </Badge>
    </span>
  );
}

ProviderBanRiskBadge.propTypes = {
  providerId: PropTypes.string.isRequired,
};
