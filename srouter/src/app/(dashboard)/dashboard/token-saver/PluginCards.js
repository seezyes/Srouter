"use client";

import styles from "./PluginCards.module.css";

export function PluginCard({ id, title, description, icon, children }) {
  return (
    <details id={id} className={styles.card}>
      <summary className={styles.summary}>
        <span className={`material-symbols-outlined ${styles.icon}`} aria-hidden="true">{icon}</span>
        <span className={styles.label}><strong>{title}</strong><span>{description}</span></span>
        <span className={`material-symbols-outlined ${styles.chevron}`} aria-hidden="true">expand_more</span>
      </summary>
      <div className={styles.panel}>{children}</div>
    </details>
  );
}

export { styles as pluginStyles };
