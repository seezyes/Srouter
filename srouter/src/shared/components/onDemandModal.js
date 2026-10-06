"use client";

import { createElement, useState } from "react";
import PropTypes from "prop-types";

/**
 * Gate a client-only dynamic component, not just its visible DOM.
 * Keep it mounted after its first opening: existing modals rely on receiving
 * isOpen=false to reset forms, abort polling and close owned OAuth proxies.
 * Owners that already conditionally mount a dialog keep their original lifetime.
 */
export default function onDemandModal(Component) {
  function OnDemandModal(props) {
    const [activated, setActivated] = useState(false);
    if (props.isOpen && !activated) setActivated(true);
    if (!props.isOpen && !activated) return null;
    return createElement(Component, props);
  }

  OnDemandModal.displayName = "OnDemandModal";
  OnDemandModal.propTypes = { isOpen: PropTypes.bool };
  return OnDemandModal;
}
