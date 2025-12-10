import React, { useState } from "react";
import axios from "axios";

function App(){
  const [genre, setGenre] = useState("fantasy");
  const [characters, setCharacters] = useState("Arya, Tom");
  const [paragraphs, setParagraphs] = useState(3);
  const [loading, setLoading] = useState(false);
  const [story, setStory] = useState("");
  const [images, setImages] = useState([]);

  const submit = async () => {
    setLoading(true);
    const resp = await axios.post("http://localhost:4000/api/generate-story", {
      genre, characters: characters.split(",").map(s=>s.trim()), paragraphs
    });
    
    setStory(resp.data.story);
    setImages(resp.data.images || []);
    setLoading(false);
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>AI Story Builder</h1>
      <label>Genre:
        <select value={genre} onChange={e=>setGenre(e.target.value)}>
          <option>fantasy</option><option>mystery</option><option>sci-fi</option>
        </select>
      </label>
      <br/>
      <label>Characters (comma separated):
        <input value={characters} onChange={e=>setCharacters(e.target.value)} />
      </label>
      <br/>
      <label>Paragraphs:
        <input type="number" min="1" max="10" value={paragraphs} onChange={e=>setParagraphs(e.target.value)} />
      </label>
      <br/>
      <button onClick={submit} disabled={loading}>{loading ? "Generating..." : "Generate"}</button>

      <h2>Story</h2>
      <div style={{ whiteSpace: "pre-wrap" }}>{story}</div>

      <h2>Images</h2>
      <div>{images.map((img, i) => (
        <div key={i}>
          {/* adapt rendering depending on response: URL or base64 */}
          {img.url ? <img src={img.url} alt={`para-${i}`} style={{maxWidth:300}} /> : (img.base64 && <img src={`data:image/png;base64,${img.base64}`} alt="img"/>)}
        </div>
      ))}</div>
    </div>
  );
}

export default App;
