(ns replicant.dom)
;; Bundled-eval note: cljrs-wasm's Repl has no filesystem / source path, so
;; `:require` on a sibling namespace that only exists because we `eval`'d its
;; `(ns ...)` form earlier in this same session fails with "Could not find
;; namespace ... on source path" (verified against cljrs-wasm 0.1.219). `alias`
;; only looks up an already-registered namespace object, so it works. This
;; mirrors the cljrs.dom workaround below, generalized to every intra-bundle
;; namespace (see vendor/replicant/NOTES.md).
(alias 'alias 'replicant.alias)
(alias 'asserts 'replicant.asserts)
(alias 'r 'replicant.core)
(alias 'errors 'replicant.errors)
(alias 'replicant 'replicant.protocols)
(alias 'transition 'replicant.transition)

;; cljrs-wasm's Repl registers cljrs.dom natively (`cljrs_dom::register`)
;; before any eval, but never marks the namespace loaded, so a normal
;; `:require` clause in the ns form above sends it through cljrs-env's
;; source-file loader, which fails with "Could not find namespace cljrs.dom
;; on source path" (there is no .cljrs/.cljc file for a native-only
;; namespace). `alias` only looks up the already-registered namespace object,
;; so it works without going through that loader.
#?(:rust (alias 'dom 'cljrs.dom))

;; cljrs's `reify` fails to resolve a namespace-qualified protocol symbol --
;; even a fully-qualified one, not just an alias -- with "is not a protocol",
;; even though the same symbol resolves fine everywhere else. It only accepts
;; a bare symbol naming a protocol interned in the *current* namespace, so the
;; create-renderer reify below (in its own #?(:rust ...) branch) uses these
;; local bindings instead of `replicant/IRender` / `replicant/IMemory`.
#?(:rust (def IRender replicant.protocols/IRender))
#?(:rust (def IMemory replicant.protocols/IMemory))

;; A solo `#?(:default ...)` also matches under :rust (no other branch in this
;; form lists it), so it must be spelled out explicitly to stay JS/CLJS-only.
#?(:rust nil
   :default
   (defn ^:no-doc remove-listener [^js/EventTarget el event opt]
     (when-let [old-handler (some-> el .-replicantHandlers (aget event))]
       (.removeEventListener el event old-handler (clj->js opt)))))

(defn ^:no-doc on-next-frame [f]
  #?(:rust (dom/request-animation-frame
            (fn [] (dom/request-animation-frame f)))
     :default (js/requestAnimationFrame
               #(js/requestAnimationFrame f))))

#?(:rust
   (defn ^:no-doc -on-transition-end [el f]
     ;; cljrs.dom exposes computed-style and listen!/unlisten!, which covers the
     ;; common case. The browser implementation additionally arms a setTimeout
     ;; fail-safe for transitions that never actually fire transitionend; cljrs
     ;; has no timer primitive exposed yet, so that safety net is omitted here.
     (let [[n _dur] (-> (dom/computed-style el "transition-duration")
                        transition/get-transition-stats)]
       (if (= n 0)
         (f)
         (let [complete (volatile! 0)
               handle (volatile! nil)
               callback (fn listener [& _args]
                          (when (<= n (vswap! complete inc))
                            (some-> @handle dom/unlisten!)
                            (f)))]
           (vreset! handle (dom/listen! el "transitionend" callback {}))))))

   :default
   (defn ^:no-doc -on-transition-end [el f]
     (let [[n dur] (-> (js/window.getComputedStyle el)
                       (.getPropertyValue "transition-duration")
                       transition/get-transition-stats)]
       (if (= n 0)
         (f)
         (let [complete (volatile! 0)
               timer (volatile! nil)
               started (js/Date.)
               callback (fn listener [& _args]
                          (let [cn (vswap! complete inc)]
                            (when (or (<= n cn)
                                      (< dur (- (js/Date.) started)))
                              (.removeEventListener el "transitionend" listener)
                              (js/clearTimeout @timer)
                              (f))))]
           (.addEventListener el "transitionend" callback)
           ;; The timer is a fail-safe. You could have set transition properties
           ;; that either don't change, or don't change in a way that triggers an
           ;; actual transition on unmount (e.g. changing height from auto to 0
           ;; causes no transition). When this happens, there will not be as many
           ;; transitionend events as there are transition durations. To avoid
           ;; getting stuck, the timer will come in and clean up.
           ;;
           ;; The timer is set with a hefty delay to avoid cutting a transition
           ;; short, in the case of a backed up browser working on overtime. Not
           ;; sure how realistic this is, but better safe than sorry, and the
           ;; important part is that the element doesn't get stuck forever.
           (vreset! timer (js/setTimeout callback (+ dur 200))))))))

#?(:rust nil :default (def ^:no-doc memories (js/WeakMap.)))

(defn ^:export recall [node]
  #?(:rust (dom/recall node)
     :default (.get ^js memories node)))

#?(:rust
   (defn ^:no-doc create-renderer []
     (reify
       IRender
       (attached? [_this el]
         (dom/connected? el))

       (create-text-node [_this text]
         (dom/create-text text))

       (create-element [_this tag-name options]
         (if-let [ns (:ns options)]
           ;; cljrs has a name-based dispatch collision between
           ;; `cljrs.dom/create-ns` (2-arity, makes a DOM element) and
           ;; `clojure.core/create-ns` (1-arity, makes a Clojure namespace):
           ;; calling `dom/create-ns` directly invokes the wrong one and
           ;; silently returns a namespace object instead of an element,
           ;; regardless of the alias/qualification used at the call site.
           ;; `apply` goes through a different, unaffected dispatch path.
           (apply dom/create-ns [ns tag-name])
           (dom/create tag-name)))

       (set-style [this el style v]
         (dom/set-style! el (name style) (str v))
         this)

       (remove-style [this el style]
         (dom/remove-style! el (name style))
         this)

       (add-class [this el cn]
         (dom/add-class! el cn)
         this)

       (remove-class [this el cn]
         (dom/remove-class! el cn)
         this)

       (set-attribute [this el attr v opt]
         ;; cljrs.dom's attribute/value setters are strict about Rust's `&str`
         ;; boundary (unlike the browser's auto-coercing `.setAttribute`), so
         ;; numeric/keyword hiccup values (e.g. SVG `:width`/`:cx`) must be
         ;; stringified explicitly for anything that isn't already a DOM
         ;; property with its own typed setter (checked/selected are boolean).
         (cond
           (= "innerHTML" attr) (dom/set-html! el v)
           (= "value" attr) (dom/set-value! el (str v))
           (= "default-value" attr) (dom/set-attr! el "value" (str v))
           (= "selected" attr) (dom/set-selected! el v)
           (= "default-selected" attr) (dom/set-attr! el "selected" (str v))
           (= "checked" attr) (dom/set-checked! el v)
           (= "default-checked" attr) (dom/set-attr! el "checked" (str v))
           (:ns opt) (dom/set-attr-ns! el (:ns opt) attr (str v))
           :else (dom/set-attr! el attr (str v)))
         this)

       (remove-attribute [this el attr]
         (cond
           (= "innerHTML" attr) (dom/set-html! el "")
           (= "value" attr) (dom/set-prop! el "value" nil)
           (= "default-value" attr) (dom/remove-attr! el "value")
           (= "selected" attr) (dom/set-prop! el "selected" nil)
           (= "default-selected" attr) (dom/remove-attr! el "selected")
           (= "checked" attr) (dom/set-prop! el "checked" nil)
           (= "default-checked" attr) (dom/remove-attr! el "checked")
           :else (dom/remove-attr! el attr))
         this)

       ;; Handler bookkeeping mirrors the browser backend, which stashes the live
       ;; listeners on the node itself (`.-replicantHandlers`). Here we store the
       ;; cljrs.dom listener handles in a Clojure map under a single node
       ;; property, so re-binding a handler can `unlisten!` the previous one. This
       ;; relies on cljrs.dom set-prop!/get-prop round-tripping a Clojure value;
       ;; see doc/cljrs-port/cljrs-dom-requirements.md for the open question.
       (set-event-handler [this el event handler opt]
         (let [event (name event)
               handlers (or (dom/get-prop el "replicantHandlers") {})]
           (some-> (get handlers event) dom/unlisten!)
           (let [listener (dom/listen! el event handler (or opt {}))]
             (dom/set-prop! el "replicantHandlers" (assoc handlers event listener))))
         this)

       (remove-event-handler [this el event opt]
         (let [event (name event)
               handlers (or (dom/get-prop el "replicantHandlers") {})]
           (some-> (get handlers event) dom/unlisten!)
           (dom/set-prop! el "replicantHandlers" (dissoc handlers event)))
         this)

       (append-child [this el child-node]
         (dom/append! el child-node)
         this)

       (insert-before [this el child-node reference-node]
         (dom/insert-before! el child-node reference-node)
         this)

       (remove-child [this el child-node]
         ;; cljrs.dom remove! detaches a node from its parent
         (dom/remove! child-node)
         this)

       (on-transition-end [this el f]
         (-on-transition-end el f)
         this)

       (replace-child [this el insert-child old-child]
         ;; cljrs.dom replace! replaces the first node with the second.
         ;; NB: the 4th param is deliberately not named `replace-child` --
         ;; cljrs's reify has a bug where a method param sharing its name
         ;; with the protocol method resolves to the outer var, not the
         ;; local binding (filed upstream; verified against 0.1.219).
         (dom/replace! old-child insert-child)
         this)

       (remove-all-children [this el]
         (dom/set-text! el "")
         this)

       (get-child [_this el idx]
         (dom/child-at el idx))

       (next-frame [_this f]
         (on-next-frame f))

       IMemory
       (remember [_this node memory]
         (dom/remember! node memory))

       (recall [_this node]
         (dom/recall node))))

   :default
   (defn ^:no-doc create-renderer []
     (reify
       replicant/IRender
       (attached? [_this el]
         (.-isConnected el))

       (create-text-node [_this text]
         (js/document.createTextNode text))

       (create-element [_this tag-name options]
         (if-let [ns (:ns options)]
           (js/document.createElementNS ns tag-name)
           (js/document.createElement tag-name)))

       (set-style [this ^js el style v]
         (.setProperty (.-style el) (name style) v)
         this)

       (remove-style [this ^js el style]
         (.removeProperty (.-style el) (name style))
         this)

       (add-class [this ^js el cn]
         (.add (.-classList el) cn)
         this)

       (remove-class [this ^js el cn]
         (.remove (.-classList el) cn)
         this)

       (set-attribute [this ^js el attr v opt]
         (errors/with-error-handling "setting attribute" {:el el :attr attr :v v}
           (cond
             (= "innerHTML" attr)
             (set! (.-innerHTML el) v)

             (= "value" attr)
             (set! (.-value el) v)

             (= "default-value" attr)
             (.setAttribute el "value" v)

             (= "selected" attr)
             (set! (.-selected el) v)

             (= "default-selected" attr)
             (.setAttribute el "selected" v)

             (= "checked" attr)
             (set! (.-checked el) v)

             (= "default-checked" attr)
             (.setAttribute el "checked" v)

             (:ns opt)
             (.setAttributeNS el (:ns opt) attr v)

             :else
             (.setAttribute el attr v)))
         this)

       (remove-attribute [this ^js el attr]
         (cond
           (= "innerHTML" attr)
           (set! (.-innerHTML el) "")

           (= "value" attr)
           (set! (.-value el) nil)

           (= "default-value" attr)
           (.removeAttribute el "value")

           (= "selected" attr)
           (set! (.-selected el) nil)

           (= "default-selected" attr)
           (.removeAttribute el "selected")

           (= "checked" attr)
           (set! (.-checked el) nil)

           (= "default-checked" attr)
           (.removeAttribute el "checked")

           :else
           (.removeAttribute el attr))
         this)

       (set-event-handler [this ^js/EventTarget el event handler opt]
         (when-not (.-replicantHandlers el)
           (set! (.-replicantHandlers el) #js {}))
         (let [event (name event)]
           (remove-listener el event opt)
           (aset (.-replicantHandlers el) event handler)
           (.addEventListener el event handler (clj->js opt)))
         this)

       (remove-event-handler [this ^js/EventTarget el event opt]
         (let [event (name event)]
           (remove-listener el event opt)
           (aset (.-replicantHandlers el) event nil))
         this)

       (append-child [this ^js el child-node]
         (.appendChild el child-node)
         this)

       (insert-before [this ^js el child-node reference-node]
         (.insertBefore el child-node reference-node)
         this)

       (remove-child [this ^js el child-node]
         (.removeChild el child-node)
         this)

       (on-transition-end [this ^js el f]
         (-on-transition-end el f)
         this)

       (replace-child [this ^js el insert-child replace-child]
         (.replaceChild el insert-child replace-child)
         this)

       (remove-all-children [this ^js el]
         (set! (.-textContent el) "")
         this)

       (get-child [_this ^js el idx]
         (aget (.-childNodes el) idx))

       (next-frame [_this f]
         (on-next-frame f))

       replicant/IMemory
       (remember [_this ^js node memory]
         (.set ^js memories node memory))

       (recall [_this ^js node]
         (.get ^js memories node)))))

;; cljrs's `defonce` doesn't accept a metadata-tagged symbol ("defonce requires
;; a symbol at position 0"); `def` works fine there, and re-eval-safety is moot
;; for a browser session that loads this namespace exactly once anyway.
#?(:rust (def ^:no-doc state (volatile! {}))
   :default (defonce ^:no-doc state (volatile! {})))

(defn ^:no-doc -clear-element [el]
  #?(:rust (dom/set-html! el "")
     :default (set! (.-innerHTML el) "")))

(defn ^:no-doc -request-frame [f]
  #?(:rust (dom/request-animation-frame f)
     :default (js/requestAnimationFrame f)))

(defn ^:no-doc -report-render-error [aliases e]
  (let [msg (str "Caught exception during rendering. "
                 (if aliases
                   "You may have misbehaving aliases, or you have encountered a bug in Replicant."
                   "This is likely a bug in Replicant."))]
    #?(:rust (do (println msg) (println e))
       :default (js/console.error msg e))))

(defn ^:export render
  "Render `hiccup` in DOM element `el`. Replaces any pre-existing content not
  created by this function. Subsequent calls with the same `el` will update the
  rendered DOM by comparing `hiccup` to the previous `hiccup`. `hiccup` can be
  either a single hiccup node, or a list of multiple nodes."
  [^js el hiccup & [{:keys [aliases alias-data]}]]
  (let [rendering? (get-in @state [el :rendering?])]
    (when-not (contains? @state el)
      (-clear-element el)
      (vswap! state assoc el {:renderer (create-renderer)
                              :unmounts (volatile! #{})
                              :unmount-hooks (volatile! (r/node-map))
                              :rendering? true}))
    (if rendering?
      (do
        (asserts/assert-no-nested-renders)
        (vswap! state assoc-in [el :queued] hiccup))
      (do
        (vswap! state assoc-in [el :rendering?] true)
        (let [{:keys [renderer current unmounts unmount-hooks]} (get @state el)
              aliases (or aliases (alias/get-registered-aliases))
              ;; with-dev-key is a clj macro tied to the cljs compiler, which
              ;; neither squint nor cljrs can expand, so the dev-key injection is
              ;; skipped on those targets
              hiccup #?(:squint hiccup
                        :rust hiccup
                        :default (if alias-data
                                   (env/with-dev-key hiccup [aliases alias-data])
                                   (env/with-dev-key hiccup aliases)))
              {:keys [vdom]} (try
                               (r/reconcile renderer el hiccup current {:unmounts unmounts
                                                                        :unmount-hooks unmount-hooks
                                                                        :aliases aliases
                                                                        :alias-data alias-data})
                               (catch #?(:clj Exception :default :default) e
                                 (-report-render-error aliases e)
                                 nil))]
          (vswap! state update el merge (cond-> {:rendering? false}
                                          vdom (assoc :current vdom)))
          (when-let [pending (:queued (get @state el))]
            (-request-frame #(render el pending))
            (vswap! state update el dissoc :queued))))))
  el)

(defn ^:export unmount
  "Unmounts elements in `el`, and clears internal state."
  [^js el]
  (if (get-in @state [el :rendering?])
    (-request-frame #(unmount el))
    (do
      (render el nil)
      (vswap! state dissoc el)
      nil)))

(defn ^:export set-dispatch!
  "Register a global dispatch function for event handlers and life-cycle hooks
  that are not functions. See data-driven event handlers and life-cycle hooks in
  the user guide for details."
  [f]
  ;; cljrs's `set!` doesn't resolve an alias-qualified symbol ("unbound symbol:
  ;; r/*dispatch*"), only a bare or fully-qualified one -- unlike plain reads,
  ;; which work fine through an alias. Spell it out under :rust.
  #?(:rust (set! replicant.core/*dispatch* f)
     :default (set! r/*dispatch* f)))
