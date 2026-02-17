import { Routes, Route } from "react-router";
import NavBar from "./components/NavBar/NavBar";
import Landing from "./components/Landing/Landing";
import { useMapsLoader } from "./hooks/useMapsLoader";

const App = () => {
  useMapsLoader();

  return (
    <>
      <NavBar />
      <Routes>
        <Route path='/' element={<Landing />} />
        <Route path='/saved' element={<Landing />} />
        <Route path='/sign-up' element={<Landing />} />
        <Route path='/sign-in' element={<Landing />} />
      </Routes>
    </>
  );
};

export default App;
