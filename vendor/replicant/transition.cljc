(ns ^:no-doc replicant.transition
  #?(:rust (:require [clojure.string :as str])))

#?(:rust
   ;; cljrs has no Java/JS string-method interop; use clojure.string / subs.
   ;; clojure.string/index-of returns nil when absent, so normalize to -1 to keep
   ;; the existing numeric (< s 0) / (< s ms) comparisons. The loop binding is
   ;; renamed off `str` to avoid colliding with the clojure.string alias.
   (defn get-transition-stats [transition-duration-s]
     (loop [s-str (str transition-duration-s)
            n 0
            duration 0]
       (let [s (or (str/index-of s-str "s") -1)
             ms (or (str/index-of s-str "ms") -1)
             comma (or (str/index-of s-str ",") -1)]
         (if (and (< s 0) (< ms 0))
           ;; cljrs has no `unchecked-int`; `int` performs the double->int
           ;; coercion the result depends on (e.g. 250.0 -> 250).
           [n (int duration)]
           (recur
            (if (< comma 0)
              ""
              (str/triml (subs s-str (inc comma))))
            (inc n)
            (max duration
                 (if (or (< s ms) (< ms 0))
                   (* 1000 (parse-double (subs s-str 0 s)))
                   (parse-long (subs s-str 0 ms)))))))))

   :default
   (defn get-transition-stats [transition-duration-s]
     (loop [str (str transition-duration-s)
            n 0
            duration 0]
       (let [s (.indexOf str "s")
             ms (.indexOf str "ms")
             comma (.indexOf str ",")]
         (if (and (< s 0) (< ms 0))
           [n (unchecked-int duration)]
           (recur
            (if (< comma 0)
              ""
              (#?(:cljs .trimLeft
                  :clj .trim) (.substring str (unchecked-inc-int comma))))
            (unchecked-inc-int n)
            (max duration
                 (if (or (< s ms) (< ms 0))
                   (* 1000 (parse-double (.substring str 0 s)))
                   (parse-long (.substring str 0 ms))))))))))
