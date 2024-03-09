import { Dispatcher } from './dispatcher'
import { makeRouteMatcher } from './route-matchers'
import { assert } from './utils/assert'

/**
 * The object passed as an argument to the route change handler.
 *
 * @typedef {Object} RouteChangeHandlerParams
 * @property {import('./route-matchers').Route} from
 * @property {import('./route-matchers').Route} to
 * @property {HashRouter} router
 */

/**
 * A function that handles route changes.
 *
 * @callback RouteChangeHandler
 * @param {RouteChangeHandlerParams} params
 * @returns {void}
 */

const ROUTER_EVENT = 'router-event'

/**
 * Implements the `HashRouter` to navigate between pages without requesting them to the server.
 * In a hash router, the location is kept in the hash portion or the URL:
 *
 * ```
 * https: // example.com : 8080 /something/ ?query=abc123 #/fooBarBaz
 *
 * ⎣____⎦    ⎣__________⎦  ⎣__⎦ ⎣________⎦ ⎣____________⎦ ⎣________⎦
 * protocol     domain     port    path      parameters      hash
 * ```
 *
 * The router is initialized with a list of routes, each with a path and a component.
 * Routes can contain parameters, which are extracted from the path and made available.
 * Parameters are defined in the path with a colon, like `/user/:id`.
 * A catch-all route can be defined with a path of `*`.
 *
 * The router starts listening to the browser's popstate events when initialized.
 * To initialize the router, call the `init()` method.
 *
 * Example:
 *
 * ```javascript
 * const routes = [
 *  { path: '/', component: Home },
 *  { path: '/one', component: One },
 *  { path: '/two/:userId/page/:pageId', component: Two },
 *  { path: '*', component: NotFound },
 * ]
 *
 * const router = new HashRouter(routes)
 * router.init()
 * ```
 */
export class HashRouter {
  /** @type {import('./route-matchers').RouteMatcher[]} */
  #matchers = []

  /** @type {import('./route-matchers').Route | null} */
  #matchedRoute = null

  #dispatcher = new Dispatcher()
  #subscriptions = new WeakMap()
  #subscriberFns = new Set()

  /**
   * The `Route` object that matches the current route or `null` if no route matches.
   */
  get matchedRoute() {
    return this.#matchedRoute
  }

  /** @type {Object<string, string>} */
  #params = {}

  /**
   * The parameters extracted from the current route's path, in an object.
   *
   * Example:
   *
   * ```javascript
   * // Given the route defined as `/users/:userId`
   * // And the URL: https://example.com/#/users/123
   * router.params
   * // => { userId: '123' }
   * ```
   */
  get params() {
    return this.#params
  }

  /** @type {Object<string, string>} */
  #query = {}

  /**
   * The query parameters extracted from the current route's path, in an object.
   *
   * Example:
   *
   * ```javascript
   * // Given the URL: https://example.com/#/path?query=abc123&foo=bar
   * router.query
   * // => { query: 'abc123', foo: 'bar' }
   * ```
   */
  get query() {
    return this.#query
  }

  // Saved to a variable to be able to remove the event listener in the destroy() method.
  #onPopState = () => this.#matchCurrentRoute()

  constructor(routes = []) {
    assert(Array.isArray(routes), 'Routes must be an array')
    this.#matchers = routes.map(makeRouteMatcher)
  }

  /**
   * Returns the current route's hash portion without the leading `#`.
   * If the hash is empty, `/` is returned.
   *
   * @returns {string} The current route hash.
   */
  get #currentRouteHash() {
    const hash = document.location.hash

    if (hash === '') {
      return '/'
    }

    return hash.slice(1)
  }

  // Whether the router is initialized or not.
  // Saved to avoid initializing the router multiple times.
  #isInitialized = false

  /**
   * Initializes the router by matching the current route to a component and
   * listening for the browser's popstate events.
   *
   * If there is no hash in the URL, it adds one.
   *
   * If the router is already initialized, calling this method again has no effect.
   */
  init() {
    if (this.#isInitialized) {
      return
    }

    if (document.location.hash === '') {
      window.history.replaceState({}, '', '#/')
    }

    window.addEventListener('popstate', this.#onPopState)
    this.#matchCurrentRoute()

    this.#isInitialized = true
  }

  /**
   * Stops listening to the browser's popstate events. If the router is not
   * initialized, calling this method has no effect.
   *
   * Call this method to clean up the router when it's no longer needed.
   */
  destroy() {
    if (!this.#isInitialized) {
      return
    }

    window.removeEventListener('popstate', this.#onPopState)
    Array.from(this.#subscriberFns).forEach(this.unsubscribe, this)
    this.#isInitialized = false
  }

  /**
   * Navigates to the given route path, matching it to a component
   * and pushing it to the browser's history.
   *
   * When there isn't a "catch-all" route defined in the router and an unknown
   * path is navigated to, the router doesn't change the URL, it simply
   * ignores the navigation, as there isn't a route to match the path to.
   *
   * On the other hand, when there is a "catch-all" route, it matches the
   * path to the catch-all route and pushes it to the browser's history.
   * In this case, the Browser's URL will point to the unknown path.
   *
   * @param {string} path The route's path or name to navigate to.
   */
  navigateTo(path) {
    this.#matchRoute(path)

    if (this.#matchedRoute) {
      this.#pushState(path)
    } else {
      console.warn(`[Router] No route matches path "${path}"`)
    }
  }

  /**
   * Navigates to the previous page in the browser's history.
   *
   * It uses the `window.history.back()` method to navigate back.
   * This is an asynchronous method. We need to listen to the popstate event to know when
   * the back action is completed.
   */
  back() {
    window.history.back()
  }

  /**
   * Navigates to the next page in the browser's history.
   *
   * It uses the `window.history.forward()` method to navigate forward.
   * This is an asynchronous method. We need to listen to the popstate event to know when
   * the forward action is completed.
   */
  forward() {
    window.history.forward()
  }

  /**
   * Subscribes a handler function to the router's route change events.
   * The handler is called every time the route changes, and the handler is passed an object
   * with the `from` and `to` routes and the router itself.
   *
   * @param {RouteChangeHandler} handler
   */
  subscribe(handler) {
    const unsubscribe = this.#dispatcher.subscribe(ROUTER_EVENT, handler)
    this.#subscriptions.set(handler, unsubscribe)
    this.#subscriberFns.add(handler)
  }

  /**
   * Unsubscribes a handler function from the router's route change events.
   *
   * @param {RouteChangeHandler} handler
   */
  unsubscribe(handler) {
    const unsubscribe = this.#subscriptions.get(handler)
    if (unsubscribe) {
      unsubscribe()
      this.#subscriptions.delete(handler)
      this.#subscriberFns.delete(handler)
    }
  }

  /**
   * A convenience method to push a path to the browser's history.
   * The path is always added to the hash portion of the URL.
   *
   * Note that the `pushState()` requires a second argument which is unused,
   * but required by the API. According to the MDN docs, it should be an empty string:
   *
   * > This parameter exists for historical reasons, and cannot be omitted;
   * > passing an empty string is safe against future changes to the method.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/History/pushState
   *
   * @param {string} path - The path to push to the browser's history.
   */
  #pushState(path) {
    window.history.pushState({}, '', `#${path}`)
  }

  #matchCurrentRoute() {
    this.#matchRoute(this.#currentRouteHash)
  }

  /**
   * Matches the given path to a route. If no route is matched, the `matchedRoute`
   * property is set to `null`. The first route that matches the path is used.
   *
   * If a new route is matched, the router dispatches a route change event.
   *
   * @param {string} path The path to match.
   */
  #matchRoute(path) {
    const matcher = this.#matchers.find((matcher) =>
      matcher.checkMatch(path)
    )

    if (matcher) {
      const from = this.#matchedRoute
      const to = matcher.route

      this.#matchedRoute = matcher.route
      this.#params = matcher.extractParams(path)
      this.#query = matcher.extractQuery(path)

      this.#dispatcher.dispatch(ROUTER_EVENT, { from, to, router: this })
    } else {
      this.#matchedRoute = null
      this.#params = {}
      this.#query = {}
    }
  }
}