/**
 * Manifest for an outer skin - admin-controlled site-level content
 * (homepage, branding, navigation).
 */
export interface OuterSkinManifest {
  /** Unique identifier for the skin, e.g., "flo-monster" */
  id: string;

  /** Display name */
  name: string;

  /** Semantic version */
  version: string;

  /** Relative URL to the HTML content file */
  contentUrl: string;

  /** Relative URL to the CSS styles file */
  stylesUrl: string;

  /** Optional relative URL to JavaScript file */
  scriptUrl?: string;

  /** Background color for the page body when this skin is displayed (e.g. "#ffffff", "#1a1a2e") */
  backgroundColor?: string;

  /** Homepage configuration */
  homepage: {
    /** Section IDs in display order */
    sections: string[];
    /** Action for the CTA button */
    ctaAction: 'credentials';
  };

  /** Navigation configuration */
  navigation: {
    /** Relative URL to logo image */
    logoUrl: string;
    /** Alt text for logo */
    logoAlt: string;
    /** Show dashboard link when on homepage */
    showDashboardLink: boolean;
  };
}
