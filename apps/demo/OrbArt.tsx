/** Prism's colour field and wave artwork, fitted to Earshot's existing bubble. */
export function OrbArt(){
 return <>
  <span className="orb-colour" aria-hidden="true"><span className="orb-colour-field"><i/><i/><i/><i/></span></span>
  <svg viewBox="0 0 120 120" aria-hidden="true"><g>
   <path className="back" d="M-120 60 Q-105 46 -90 60 T-60 60 T-30 60 T0 60 T30 60 T60 60 T90 60 T120 60 T150 60 T180 60 T210 60 T240 60"/>
   <path className="middle" d="M-100 60 Q-87.5 71 -75 60 T-50 60 T-25 60 T0 60 T25 60 T50 60 T75 60 T100 60 T125 60 T150 60 T175 60 T200 60 T225 60"/>
   <path className="front" d="M-100 60 Q-90 38 -80 60 T-60 60 T-40 60 T-20 60 T0 60 T20 60 T40 60 T60 60 T80 60 T100 60 T120 60 T140 60 T160 60 T180 60 T200 60 T220 60 T240 60 T260 60"/>
  </g></svg>
 </>;
}
