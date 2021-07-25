import type {
  ElementAst,
  EmbeddedTemplateAst,
  ReferenceAst,
  VariableAst,
} from "@angular/compiler";
import type { TSESLint, TSESTree } from "@typescript-eslint/experimental-utils";
import { createESLintRule, ensureTemplateParser } from "../get-parser-service";
import { MESSAGE_IDS } from "../message-ids";
import type { MessageIds, PropertyReadWithParent, RuleOptions } from "../types";
import Utils from "../utils";

export const RULE_NAME = "eslint-plugin-angular-template-consistent-this";

/**
 * Structural directives that are known to contain template *reference* variables.
 * See https://angular.io/guide/built-in-directives#built-in-structural-directives
 */
const SAFE_STRUCTURAL_DIRECTIVES: Array<string> = [
  "ngIfThen", // Then case in NgIf directive.
  "ngIfElse", // Else case in NgIf directive.
  "ngTemplateOutlet", // Template.
];

const SAFE_GLOBALS = [
  "$event", // EventEmitter.
];

export default createESLintRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  defaultOptions: [
    {
      properties: "explicit",
      variables: "implicit",
      templateReferences: "implicit",
    },
  ],

  meta: {
    type: "suggestion",
    docs: {
      description:
        "ESLint Angular Template consistent this for properties, variables & template references.",
      category: "Stylistic Issues",
      recommended: false,
      // url: "https://github.com/jerone/eslint-plugin-angular-template-consistent-this/blob/master/docs/rules/eslint-plugin-angular-template-consistent-this.md",
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          properties: {
            type: "string",
            enum: ["explicit", "implicit"],
            default: "explicit",
          },
          variables: {
            type: "string",
            enum: ["explicit", "implicit"],
            default: "implicit",
          },
          templateReferences: {
            type: "string",
            enum: ["explicit", "implicit"],
            default: "implicit",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      explicitThisProperties: "Use explicit this for property `{{prop}}`.",
      implicitThisProperties:
        "Don't use explicit this for property `{{prop}}`.",
      explicitThisVariables: "Use explicit this for variable `{{prop}}`.",
      implicitThisVariables: "Don't use explicit this for variable `{{prop}}`.",
      explicitThisTemplateReferences:
        "Use explicit this for template references `{{prop}}`.",
      implicitThisTemplateReferences:
        "Don't use explicit this for template references `{{prop}}`.",
    },
  },
  create: createRuleListener,
});

function createRuleListener(
  context: Readonly<TSESLint.RuleContext<MessageIds, RuleOptions>>,
  [options]: Readonly<RuleOptions>
): TSESLint.RuleListener {
  ensureTemplateParser(context);

  const variables: Array<VariableAst> = [];
  const templates: Array<ReferenceAst> = [];

  return {
    /**
     * This visitor contains the scoped variables and global templates references.
     * Variables should always be defined *before* property reading.
     * But template references can be defined *after* where they are being read.
     * See: https://angular.io/guide/structural-directives#template-input-variable
     * @param {*} node
     */
    Template(node: EmbeddedTemplateAst): void {
      variables.push(...node.variables);
      templates.push(...node.references);
    },

    Element(node: ElementAst): void {
      if (node.references && node.references.length > 0) {
        templates.push(...node.references);
      }
    },

    PropertyRead(node: PropertyReadWithParent): void {
      const isImplicitReceiver = Utils.isImplicitReceiver(node);
      const isExplicitReceiver = Utils.isExplicitReceiver(node);

      // We're looking for `ThisReceiver` and `ImplicitReceiver`.
      // Everything else we're going to ignore.
      if (!isImplicitReceiver && !isExplicitReceiver) {
        return;
      }

      // Some globals are safe as they are.
      if (SAFE_GLOBALS.includes(node.name)) {
        return;
      }

      // 1) Template *input* variable (`let foo;`).
      // Variables are defined before they are used.
      if (variables.map((x: VariableAst) => x.name).includes(node.name)) {
        if (options.variables === "explicit" && isImplicitReceiver) {
          return reportError(
            context,
            true,
            MESSAGE_IDS.variables.explicit,
            node
          );
        } else if (options.variables === "implicit" && isExplicitReceiver) {
          return reportError(
            context,
            false,
            MESSAGE_IDS.variables.implicit,
            node
          );
        }

        return;
      }

      // 2) Template *reference* variable (`#template`).
      // This will only catch templates that are defined *before* property reading.
      if (templates.map((x: ReferenceAst) => x.name).includes(node.name)) {
        if (options.templateReferences === "explicit" && isImplicitReceiver) {
          return reportError(
            context,
            true,
            MESSAGE_IDS.templateReferences.explicit,
            node
          );
        } else if (
          options.templateReferences === "implicit" &&
          isExplicitReceiver
        ) {
          return reportError(
            context,
            false,
            MESSAGE_IDS.templateReferences.implicit,
            node
          );
        }

        return;
      }

      // 3) Check if property is part of an safe structural directives.
      // This happens for templates that haven't been caught by check 2.
      // TODO: Template reference variables can also be referenced from TS. See https://angular.io/api/common/NgIf#using-an-external-then-template
      if (SAFE_STRUCTURAL_DIRECTIVES.includes(node.parent.parent.name)) {
        if (options.templateReferences === "explicit" && isImplicitReceiver) {
          return reportError(
            context,
            true,
            MESSAGE_IDS.templateReferences.explicit,
            node
          );
        } else if (
          options.templateReferences === "implicit" &&
          isExplicitReceiver
        ) {
          return reportError(
            context,
            false,
            MESSAGE_IDS.templateReferences.implicit,
            node
          );
        }

        return;
      }

      // 4) Interpolation of databinding property.
      if (options.properties === "explicit" && isImplicitReceiver) {
        return reportError(
          context,
          true,
          MESSAGE_IDS.properties.explicit,
          node
        );
      } else if (options.properties === "implicit" && isExplicitReceiver) {
        return reportError(
          context,
          false,
          MESSAGE_IDS.properties.implicit,
          node
        );
      }
    },
  };
}

/**
 * Report explicit of implicit error to ESLint.
 * @param {boolean} explicit True for explicit error, false for implicit error.
 * @param {string} messageId Message identifier.
 * @param {string} node Node.
 */
function reportError(
  context: Readonly<TSESLint.RuleContext<MessageIds, RuleOptions>>,
  explicit: boolean,
  messageId: MessageIds,
  node: PropertyReadWithParent | VariableAst | ReferenceAst | any
): void {
  const sourceCode = context.getSourceCode();

  const loc: Readonly<TSESTree.SourceLocation> = {
    start: sourceCode.getLocFromIndex(node.sourceSpan.start),
    end: sourceCode.getLocFromIndex(node.sourceSpan.end),
  };
  const startIndex: number = sourceCode.getIndexFromLoc(loc.start);

  context.report({
    messageId,
    data: { prop: node.name },
    loc,
    fix: (fixer: TSESLint.RuleFixer) => {
      if (explicit) {
        return fixer.insertTextBeforeRange([startIndex, startIndex], "this.");
      } else {
        return fixer.replaceTextRange(
          [startIndex, startIndex + "this.".length],
          ""
        );
      }
    },
  });
}
