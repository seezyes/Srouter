"use client";

import dynamic from "next/dynamic";
import onDemandModal from "./onDemandModal";

// Keep dynamic() at module scope with literal imports so Next can identify
// separate client chunks. The outer gate prevents closed dialogs loading them.
export const OAuthModal = onDemandModal(dynamic(() => import("./OAuthModal"), { ssr: false }));
export const ModelSelectModal = onDemandModal(dynamic(() => import("./ModelSelectModal"), { ssr: false }));
export const ManualConfigModal = onDemandModal(dynamic(() => import("./ManualConfigModal"), { ssr: false }));
export const ComboFormModal = onDemandModal(dynamic(() => import("./ComboFormModal"), { ssr: false }));
export const McpMarketplaceModal = onDemandModal(dynamic(() => import("./McpMarketplaceModal"), { ssr: false }));
export const ChangelogModal = onDemandModal(dynamic(() => import("./ChangelogModal"), { ssr: false }));
export const KiroAuthModal = onDemandModal(dynamic(() => import("./KiroAuthModal"), { ssr: false }));
export const KiroOAuthWrapper = onDemandModal(dynamic(() => import("./KiroOAuthWrapper"), { ssr: false }));
export const KiroSocialOAuthModal = onDemandModal(dynamic(() => import("./KiroSocialOAuthModal"), { ssr: false }));
export const CursorAuthModal = onDemandModal(dynamic(() => import("./CursorAuthModal"), { ssr: false }));
export const ZedAuthModal = onDemandModal(dynamic(() => import("./ZedAuthModal"), { ssr: false }));
export const XiaomiMimoAuthModal = onDemandModal(dynamic(() => import("./XiaomiMimoAuthModal"), { ssr: false }));
export const IFlowCookieModal = onDemandModal(dynamic(() => import("./IFlowCookieModal"), { ssr: false }));
export const GitLabAuthModal = onDemandModal(dynamic(() => import("./GitLabAuthModal"), { ssr: false }));
export const EditConnectionModal = onDemandModal(dynamic(() => import("./EditConnectionModal"), { ssr: false }));
export const AddCustomEmbeddingModal = onDemandModal(dynamic(() => import("./AddCustomEmbeddingModal"), { ssr: false }));
export const AddCustomSearchProviderModal = onDemandModal(dynamic(() => import("./AddCustomSearchProviderModal"), { ssr: false }));
export const DonateModal = onDemandModal(dynamic(() => import("./DonateModal"), { ssr: false }));
export const NineRemotePromoModal = onDemandModal(dynamic(() => import("./NineRemotePromoModal"), { ssr: false }));
export const PricingModal = onDemandModal(dynamic(() => import("./PricingModal"), { ssr: false }));
