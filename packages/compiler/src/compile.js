import { parse } from 'node-html-parser'
import { normalizeTagName } from './tag'
import { extractProps } from './props'
import { interpolateVariables } from './variables'
import { splitAttributes } from './attributes'
import { formatForDirective } from './for-directive'
import { addThisContext } from './context'

const NODE_TYPE = {
  ELEMENT: 1,
  TEXT: 3,
}

export function compileTemplate(template) {
  const compiler = new TemplateCompiler()
  return compiler.compile(template)
}

export class TemplateCompiler {
  #lines = []
  #stack = []
  #imports = new Set()

  #reset() {
    this.#lines = ['function render() {', 'return (']
    this.#stack = [')', '}']
    this.#imports = new Set()
  }

  /**
   * Compiles the given HTML template into a render function.
   * It transforms the directives into JavaScript code.
   *
   * @param {string} template the HTML template to compile
   * @returns {object} the compiled render function
   */
  compile(template) {
    this.#reset()
    const { childNodes } = parse(normalize(template))

    // Top level contiguous elements are wrapped in a fragment.
    if (childNodes.length > 1) {
      this.#lines.push('h(Fragment, {}, [')
      this.#imports.add('hFragment')
      this.#stack.unshift('])')
    }

    for (const node of childNodes) {
      this.#addNode(node)
    }

    while (this.#stack.length) {
      this.#addLineFromStack()
    }

    return {
      imports: this.#imports,
      code: this.#lines.join(' '),
    }
  }

  #addNode(node) {
    switch (node.nodeType) {
      case NODE_TYPE.ELEMENT: {
        this.#addElement(node)
        break
      }
      case NODE_TYPE.TEXT: {
        this.#addText(node)
        break
      }
    }
  }

  #addElement(node) {
    const { rawTagName, childNodes, attributes } = node
    let closingsCount = 1

    const tag = normalizeTagName(rawTagName)
    const {
      attributes: attrs,
      bindings,
      events,
      directives,
    } = splitAttributes(attributes)
    const props = extractProps(attrs, bindings, events)

    if ('for' in directives) {
      const { line, closing } = formatForDirective(directives.for)

      // -- start --
      this.#lines[this.#lines.length - 1] = this.#lines[
        this.#lines.length - 1
      ].slice(0, -2)
      this.#stack[0] = this.#stack[0].slice(1)
      // -- end --

      this.#lines.push(line)
      this.#stack.unshift(closing)
      closingsCount++
    }
    if ('show' in directives) {
      const condition = addThisContext(directives.show)
      this.#lines.push(`${condition} ?`)
      this.#stack.unshift(': null')
      closingsCount++
    }

    this.#lines.push(`h(${tag}, ${props}, [`)
    this.#imports.add('h')
    this.#stack.unshift(']),')

    childNodes.forEach((node) => this.#addNode(node))

    while (closingsCount--) {
      this.#addLineFromStack()
    }
  }

  #addText(node) {
    const { rawText } = node
    const text = rawText.trim()

    if (text) {
      this.#lines.push(`hString(${interpolateVariables(text)}),`)
      this.#imports.add('hString')
    }
  }

  #addLineFromStack() {
    let line = this.#stack.shift()
    const prevIdx = this.#lines.length - 1
    const prevLine = this.#lines[prevIdx]

    // Remove the trailing comma in the previous line if the next
    // character is a closing parenthesis or bracket or colon.
    if (/,\s*$/.test(prevLine) && /^\s*[\)\]:]/.test(line)) {
      this.#lines[prevIdx] = prevLine.slice(0, -1)
    }

    this.#lines.push(line)
  }
}

/**
 * Removes newlines and replaces all the whitespace between tags.
 *
 * @param {string} str the string to normalize
 * @returns {string} the normalized string
 */
function normalize(str) {
  return str.replace(/\n/g, ' ').replace(/>\s+</g, '><').trim()
}
